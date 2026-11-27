import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { errorMessage, isRecord } from "../shared/guards.ts";
import { createIgnoreRule, type IgnoreRule, isIgnoredByRules } from "../shared/ignore.ts";
import { stripBom } from "../shared/json.ts";

export const CONTEXT_FILE = "AGENTS.md";
export const CONTEXT_FILENAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;
export const SKILL_FILE = "SKILL.md";
export const AGENTS_SKILLS_DIR = ".agents/skills";

const IGNORE_FILENAMES = [".gitignore", ".ignore", ".fdignore"] as const;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const SKILL_NAME_RE = /^[a-z0-9-]+$/;

export type ContextFile = {
  readonly path: string;
  readonly content: string;
  readonly workspace?: string;
};

export type SkillInfo = {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly baseDir: string;
  readonly source: "global" | "workspace";
  readonly disableModelInvocation: boolean;
  readonly workspace?: string;
};

export type SkillDiagnostic = {
  readonly type: "warning" | "collision" | "error";
  readonly message: string;
  readonly path: string;
  readonly skillName?: string;
};

export type SkillTriggerMode = "model" | "user" | "disabled";

export type SkillPolicyMap = Readonly<Record<string, SkillTriggerMode>>;

export type ContextDiscovery = {
  readonly contextFiles: readonly ContextFile[];
  readonly skills: readonly SkillInfo[];
  readonly skillDiagnostics: readonly SkillDiagnostic[];
};

export type PromptContextOptions = {
  readonly globalDir?: string;
  readonly userHomeDir?: string | null;
  readonly workspaces?: readonly string[];
};

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function canonicalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathsEqual(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isPathWithin(parent: string, child: string): boolean {
  const parentKey = pathKey(parent);
  const childKey = pathKey(child);
  if (childKey === parentKey) return true;
  return childKey.startsWith(parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`);
}

function ancestorsOf(dir: string): string[] {
  const chain: string[] = [];
  let current = resolve(dir);
  while (true) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse();
}

async function loadContextFileFromDir(
  dir: string,
): Promise<{ path: string; content: string } | undefined> {
  const candidates = CONTEXT_FILENAMES.map((filename) => join(dir, filename));
  const matches = await Promise.all(candidates.map((candidate) => isFile(candidate)));
  for (let index = 0; index < candidates.length; index++) {
    if (!matches[index]) continue;
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const raw = await readTextFile(candidate);
    if (raw !== undefined) {
      return { path: candidate, content: stripBom(raw) };
    }
  }
  return undefined;
}

type GitPaths = {
  readonly repoDir: string;
  readonly commonGitDir: string;
};

type ResolvedWorkspace = {
  readonly resolved: string;
  readonly canonical: string;
  readonly canonicalKey: string;
  readonly gitPaths: GitPaths | undefined;
  readonly rootToLeafAncestors: readonly string[];
};

async function resolveWorkspaces(
  rawWorkspaces: readonly string[] | undefined,
): Promise<ResolvedWorkspace[]> {
  if (rawWorkspaces === undefined || rawWorkspaces.length === 0) return [];
  const resolvedEntries = await Promise.all(
    rawWorkspaces.map(async (raw) => {
      const resolved = resolve(raw);
      const canonical = await canonicalizePath(resolved);
      return { resolved, canonical, canonicalKey: pathKey(canonical) };
    }),
  );
  const unique: { resolved: string; canonical: string; canonicalKey: string }[] = [];
  const seen = new Set<string>();
  for (const entry of resolvedEntries) {
    if (seen.has(entry.canonicalKey)) continue;
    seen.add(entry.canonicalKey);
    unique.push(entry);
  }
  return Promise.all(
    unique.map(async (entry) => ({
      ...entry,
      gitPaths: await findGitPaths(entry.resolved),
      rootToLeafAncestors: ancestorsOf(entry.resolved),
    })),
  );
}

async function findGitPaths(cwd: string): Promise<GitPaths | undefined> {
  let dir = resolve(cwd);
  while (true) {
    const gitPath = join(dir, ".git");
    let info: Stats | undefined;
    try {
      info = await stat(gitPath);
    } catch {
      info = undefined;
    }
    if (info !== undefined) {
      try {
        if (info.isFile()) {
          const content = (await readTextFile(gitPath))?.trim() ?? "";
          const match = /^gitdir:\s*(.+)$/im.exec(content);
          if (match?.[1] !== undefined) {
            const gitDir = resolve(dir, match[1].trim());
            if (!(await pathExists(join(gitDir, "HEAD")))) return undefined;
            const commonDirRaw = await readTextFile(join(gitDir, "commondir"));
            const commonGitDir =
              commonDirRaw !== undefined && commonDirRaw.trim() !== ""
                ? resolve(gitDir, commonDirRaw.trim())
                : gitDir;
            return { repoDir: dir, commonGitDir };
          }
        } else if (info.isDirectory()) {
          if (!(await pathExists(join(gitPath, "HEAD")))) return undefined;
          return { repoDir: dir, commonGitDir: gitPath };
        }
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function findShadowedContextFile(
  gitPaths: GitPaths | undefined,
  loadDir: (dir: string) => Promise<{ path: string; content: string } | undefined>,
): Promise<string | undefined> {
  if (gitPaths === undefined) return undefined;
  const commonGitDir = await canonicalizePath(gitPaths.commonGitDir);
  const worktreeRoot = await canonicalizePath(gitPaths.repoDir);
  const mainRepoRoot = dirname(commonGitDir);
  if (!isPathWithin(mainRepoRoot, worktreeRoot) || pathsEqual(worktreeRoot, mainRepoRoot)) {
    return undefined;
  }
  if (!pathsEqual(await canonicalizePath(join(mainRepoRoot, ".git")), commonGitDir)) {
    return undefined;
  }
  const worktreeContextFile = await loadDir(worktreeRoot);
  return worktreeContextFile === undefined
    ? undefined
    : join(mainRepoRoot, basename(worktreeContextFile.path));
}

async function discoverContextFilesInternal(
  options: PromptContextOptions,
  workspaces: readonly ResolvedWorkspace[],
): Promise<ContextFile[]> {
  const found: ContextFile[] = [];
  const seen = new Set<string>();

  const contextDirCache = new Map<string, Promise<{ path: string; content: string } | undefined>>();
  const loadDirCached = (dir: string) => {
    const key = pathKey(dir);
    let pending = contextDirCache.get(key);
    if (pending === undefined) {
      pending = loadContextFileFromDir(dir);
      contextDirCache.set(key, pending);
    }
    return pending;
  };

  const canonicalCache = new Map<string, Promise<string>>();
  const canonicalizeCached = (path: string) => {
    const key = pathKey(path);
    let pending = canonicalCache.get(key);
    if (pending === undefined) {
      pending = canonicalizePath(path);
      canonicalCache.set(key, pending);
    }
    return pending;
  };

  if (options.globalDir !== undefined) {
    const globalFile = await loadDirCached(options.globalDir);
    if (globalFile !== undefined) {
      seen.add(pathKey(await canonicalizeCached(globalFile.path)));
      found.push(globalFile);
    }
  }

  const multipleWorkspaces = workspaces.length > 1;
  const workspaceResults = await Promise.all(
    workspaces.map(async (workspace) => {
      const [shadowedContextFile, candidates] = await Promise.all([
        findShadowedContextFile(workspace.gitPaths, loadDirCached),
        Promise.all(workspace.rootToLeafAncestors.map((dir) => loadDirCached(dir))),
      ]);
      return { workspace, shadowedContextFile, candidates };
    }),
  );

  for (const { workspace, shadowedContextFile, candidates } of workspaceResults) {
    for (let index = 0; index < workspace.rootToLeafAncestors.length; index++) {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      const dir = workspace.rootToLeafAncestors[index];
      if (dir === undefined) continue;
      const canonicalDir = await canonicalizeCached(dir);
      // Compare the directory's real path: a worktree context file symlinked to the main repo resolves to the shadowed path.
      const isShadowed =
        shadowedContextFile !== undefined &&
        pathsEqual(join(canonicalDir, basename(candidate.path)), shadowedContextFile);
      if (isShadowed) continue;

      const canonical = pathKey(await canonicalizeCached(candidate.path));
      if (seen.has(canonical)) continue;
      seen.add(canonical);

      if (!multipleWorkspaces) {
        found.push(candidate);
        continue;
      }
      const matchingWorkspaces = workspaces.filter((ws) =>
        isPathWithin(canonicalDir, ws.canonical),
      );
      found.push(
        matchingWorkspaces.length === 1
          ? { ...candidate, workspace: workspace.resolved }
          : candidate,
      );
    }
  }

  return found;
}

export async function discoverContextFiles(options: PromptContextOptions): Promise<ContextFile[]> {
  const workspaces = await resolveWorkspaces(options.workspaces);
  return discoverContextFilesInternal(options, workspaces);
}

type ExtractedFrontmatter = {
  readonly hasFrontmatter: boolean;
  readonly yamlText: string;
  readonly body: string;
};

function extractSkillFrontmatter(text: string): ExtractedFrontmatter {
  const normalized = stripBom(text).replace(/\r\n/g, "\n");
  const match = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n([\s\S]*))?$/.exec(normalized);
  if (match === null) {
    return { hasFrontmatter: false, yamlText: "", body: normalized };
  }
  return {
    hasFrontmatter: true,
    yamlText: match[1] ?? "",
    body: match[2] ?? "",
  };
}

export function stripSkillFrontmatter(content: string): string {
  return extractSkillFrontmatter(content).body;
}

type ParsedSkillFrontmatter = {
  readonly name?: string;
  readonly description?: string;
  readonly disableModelInvocation?: boolean;
};

type ParsedSkillDocument = {
  readonly frontmatter: ParsedSkillFrontmatter;
  readonly error?: string;
};

function parseSkillDocument(text: string): ParsedSkillDocument {
  const { hasFrontmatter, yamlText } = extractSkillFrontmatter(text);
  if (!hasFrontmatter) return { frontmatter: {} };

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText, { logLevel: "silent" });
  } catch (error) {
    return {
      frontmatter: {},
      error: errorMessage(error),
    };
  }

  if (parsed === null || parsed === undefined) return { frontmatter: {} };
  if (!isRecord(parsed)) {
    return { frontmatter: {}, error: "Skill frontmatter must be a YAML object" };
  }

  const rawName = parsed.name;
  const rawDescription = parsed.description;
  const rawDisableModelInvocation = parsed["disable-model-invocation"];

  const name = typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : undefined;
  const description =
    typeof rawDescription === "string" && rawDescription.trim() !== ""
      ? rawDescription.trim()
      : undefined;
  const disableModelInvocation =
    typeof rawDisableModelInvocation === "boolean" ? rawDisableModelInvocation : undefined;

  return {
    frontmatter: {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }),
    },
  };
}

export function parseSkillFrontmatter(text: string): {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
} {
  return { ...parseSkillDocument(text).frontmatter };
}

export function resolveSkillTriggerMode(
  skill: SkillInfo,
  policy?: SkillPolicyMap,
): SkillTriggerMode {
  const configured =
    policy !== undefined && Object.hasOwn(policy, skill.name) ? policy[skill.name] : undefined;
  if (configured !== undefined) return configured;
  return skill.disableModelInvocation ? "user" : "model";
}

async function readIgnoreRules(dir: string, base: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const filename of IGNORE_FILENAMES) {
    const raw = await readTextFile(join(dir, filename));
    if (raw === undefined || raw.trim() === "") continue;
    rules.push(createIgnoreRule(base, raw));
  }
  return rules;
}

async function statTarget(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function skillAncestorsForWorkspace(workspace: ResolvedWorkspace): string[] {
  const repoDir = workspace.gitPaths?.repoDir;
  const chain: string[] = [];
  for (let index = workspace.rootToLeafAncestors.length - 1; index >= 0; index--) {
    const dir = workspace.rootToLeafAncestors[index];
    if (dir === undefined) continue;
    chain.push(dir);
    if (repoDir !== undefined && pathsEqual(dir, repoDir)) break;
  }
  return chain;
}

function validateSkillName(name: string, filePath: string, diagnostics: SkillDiagnostic[]): void {
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    diagnostics.push({
      type: "warning",
      message: `Skill name "${name}" exceeds ${MAX_SKILL_NAME_LENGTH} characters (${name.length})`,
      path: filePath,
      skillName: name,
    });
  }
  if (!SKILL_NAME_RE.test(name)) {
    diagnostics.push({
      type: "warning",
      message: `Skill name "${name}" contains invalid characters (must match /^[a-z0-9-]+$/)`,
      path: filePath,
      skillName: name,
    });
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    diagnostics.push({
      type: "warning",
      message: `Skill name "${name}" must not start or end with a hyphen`,
      path: filePath,
      skillName: name,
    });
  }
  if (name.includes("--")) {
    diagnostics.push({
      type: "warning",
      message: `Skill name "${name}" must not contain consecutive hyphens`,
      path: filePath,
      skillName: name,
    });
  }
}

type SkillCollectionState = {
  readonly skills: SkillInfo[];
  readonly skillsByName: Map<string, SkillInfo>;
  readonly seenFiles: Set<string>;
  readonly diagnostics: SkillDiagnostic[];
};

async function loadSkillFile(
  filePath: string,
  source: "global" | "workspace",
  workspace: string | undefined,
  state: SkillCollectionState,
): Promise<void> {
  const canonicalFileKey = pathKey(await canonicalizePath(filePath));
  if (state.seenFiles.has(canonicalFileKey)) return;
  state.seenFiles.add(canonicalFileKey);

  const text = await readTextFile(filePath);
  if (text === undefined) return;

  const fallbackName =
    basename(filePath) === SKILL_FILE ? basename(dirname(filePath)) : basename(filePath, ".md");
  const parsed = parseSkillDocument(text);
  if (parsed.error !== undefined) {
    state.diagnostics.push({
      type: "error",
      message: parsed.error,
      path: filePath,
      skillName: fallbackName,
    });
    return;
  }

  const name = parsed.frontmatter.name ?? fallbackName;
  const description = parsed.frontmatter.description;
  if (description === undefined || description === "") {
    state.diagnostics.push({
      type: "error",
      message: "description is required",
      path: filePath,
      skillName: name,
    });
    return;
  }

  validateSkillName(name, filePath, state.diagnostics);
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    state.diagnostics.push({
      type: "warning",
      message: `Skill description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters (${description.length})`,
      path: filePath,
      skillName: name,
    });
  }

  const existing = state.skillsByName.get(name);
  if (existing !== undefined) {
    state.diagnostics.push({
      type: "collision",
      message: `Skill name "${name}" collision: "${filePath}" shadowed by "${existing.path}"`,
      path: filePath,
      skillName: name,
    });
    return;
  }

  const skill: SkillInfo = {
    name,
    description,
    path: filePath,
    baseDir: dirname(filePath),
    source,
    disableModelInvocation: parsed.frontmatter.disableModelInvocation === true,
    ...(workspace === undefined ? {} : { workspace }),
  };
  state.skillsByName.set(name, skill);
  state.skills.push(skill);
}

async function scanSkillsDirectory(
  dir: string,
  base: string,
  includeRootFiles: boolean,
  inheritedRules: readonly IgnoreRule[],
  visitedDirs: Set<string>,
  source: "global" | "workspace",
  workspace: string | undefined,
  state: SkillCollectionState,
): Promise<void> {
  const canonicalDirKey = pathKey(await canonicalizePath(dir));
  if (visitedDirs.has(canonicalDirKey)) return;
  visitedDirs.add(canonicalDirKey);

  const localRules = await readIgnoreRules(dir, base);
  const rules = localRules.length === 0 ? inheritedRules : [...inheritedRules, ...localRules];

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  if (!includeRootFiles) {
    const skillEntry = entries.find((entry) => entry.name === SKILL_FILE);
    if (skillEntry !== undefined) {
      const skillPath = join(dir, SKILL_FILE);
      const relSkillPath = base === "" ? SKILL_FILE : `${base}/${SKILL_FILE}`;
      const info = await statTarget(skillPath);
      if (info?.isFile() && !isIgnoredByRules(rules, relSkillPath, false)) {
        await loadSkillFile(skillPath, source, workspace, state);
        return;
      }
    }
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const fullPath = join(dir, entry.name);
    const relPath = base === "" ? entry.name : `${base}/${entry.name}`;
    let entryIsDir: boolean;
    let entryIsFile: boolean;
    if (entry.isSymbolicLink()) {
      const info = await statTarget(fullPath);
      if (info === undefined) continue;
      entryIsDir = info.isDirectory();
      entryIsFile = info.isFile();
    } else {
      entryIsDir = entry.isDirectory();
      entryIsFile = entry.isFile();
    }

    if (!entryIsDir && !entryIsFile) continue;
    if (isIgnoredByRules(rules, relPath, entryIsDir)) continue;

    if (entryIsDir) {
      await scanSkillsDirectory(
        fullPath,
        relPath,
        false,
        rules,
        visitedDirs,
        source,
        workspace,
        state,
      );
    } else if (includeRootFiles && entryIsFile && entry.name.endsWith(".md")) {
      await loadSkillFile(fullPath, source, workspace, state);
    }
  }
}

async function scanSkillsRoot(
  rootDir: string,
  source: "global" | "workspace",
  workspace: string | undefined,
  state: SkillCollectionState,
): Promise<void> {
  const info = await statTarget(rootDir);
  if (info?.isDirectory() !== true) return;
  await scanSkillsDirectory(rootDir, "", true, [], new Set<string>(), source, workspace, state);
}

async function discoverSkillsWithDiagnosticsInternal(
  options: PromptContextOptions,
  workspaces: readonly ResolvedWorkspace[],
): Promise<{
  readonly skills: readonly SkillInfo[];
  readonly diagnostics: readonly SkillDiagnostic[];
}> {
  const state: SkillCollectionState = {
    skills: [],
    skillsByName: new Map(),
    seenFiles: new Set(),
    diagnostics: [],
  };

  const globalHome = options.userHomeDir === null ? undefined : (options.userHomeDir ?? homedir());
  const globalSkillsDir =
    globalHome !== undefined && globalHome !== ""
      ? join(resolve(globalHome), AGENTS_SKILLS_DIR)
      : undefined;
  const [globalSkillsDirKey, hostGlobalSkillsDirKey] = await Promise.all([
    globalSkillsDir === undefined
      ? Promise.resolve(undefined)
      : canonicalizePath(globalSkillsDir).then(pathKey),
    // Never treat the host ~/.agents/skills as a workspace skill when walking non-git temp/home ancestors.
    canonicalizePath(join(resolve(homedir()), AGENTS_SKILLS_DIR)).then(pathKey),
  ]);

  const scannedRoots = new Set<string>();
  const workspaceSkillDirs = await Promise.all(
    workspaces.map(async (workspace) => {
      const candidates = await Promise.all(
        skillAncestorsForWorkspace(workspace).map(async (dir) => {
          const skillsDir = join(dir, AGENTS_SKILLS_DIR);
          const info = await statTarget(skillsDir);
          if (info?.isDirectory() !== true) return undefined;
          const canonicalRootKey = pathKey(await canonicalizePath(skillsDir));
          return { skillsDir, canonicalRootKey };
        }),
      );
      return { workspace: workspace.resolved, candidates };
    }),
  );

  for (const { workspace, candidates } of workspaceSkillDirs) {
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      if (
        candidate.canonicalRootKey === hostGlobalSkillsDirKey ||
        (globalSkillsDirKey !== undefined && candidate.canonicalRootKey === globalSkillsDirKey)
      ) {
        continue;
      }
      if (scannedRoots.has(candidate.canonicalRootKey)) continue;
      scannedRoots.add(candidate.canonicalRootKey);
      await scanSkillsRoot(candidate.skillsDir, "workspace", workspace, state);
    }
  }

  if (globalSkillsDir !== undefined) {
    const info = await statTarget(globalSkillsDir);
    if (info?.isDirectory()) {
      const canonicalRootKey = pathKey(await canonicalizePath(globalSkillsDir));
      if (!scannedRoots.has(canonicalRootKey)) {
        scannedRoots.add(canonicalRootKey);
        await scanSkillsRoot(globalSkillsDir, "global", undefined, state);
      }
    }
  }

  return {
    skills: state.skills,
    diagnostics: state.diagnostics,
  };
}

export async function discoverSkillsWithDiagnostics(options: PromptContextOptions): Promise<{
  readonly skills: readonly SkillInfo[];
  readonly diagnostics: readonly SkillDiagnostic[];
}> {
  const workspaces = await resolveWorkspaces(options.workspaces);
  return discoverSkillsWithDiagnosticsInternal(options, workspaces);
}

export async function discoverSkills(options: PromptContextOptions): Promise<SkillInfo[]> {
  const result = await discoverSkillsWithDiagnostics(options);
  return [...result.skills];
}

export async function discoverContext(options: PromptContextOptions): Promise<ContextDiscovery> {
  const workspaces = await resolveWorkspaces(options.workspaces);
  const [contextFiles, skillsResult] = await Promise.all([
    discoverContextFilesInternal(options, workspaces),
    discoverSkillsWithDiagnosticsInternal(options, workspaces),
  ]);
  return {
    contextFiles,
    skills: skillsResult.skills,
    skillDiagnostics: skillsResult.diagnostics,
  };
}
