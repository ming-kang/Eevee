import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { parse as parseYaml } from "yaml";
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
export const SKILLS_DIR = "skills";
export const PI_SKILLS_DIR = ".pi/skills";
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
  for (const filename of CONTEXT_FILENAMES) {
    const candidate = join(dir, filename);
    if (!(await isFile(candidate))) continue;
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

async function findShadowedContextFile(cwd: string): Promise<string | undefined> {
  const gitPaths = await findGitPaths(cwd);
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
  const worktreeContextFile = await loadContextFileFromDir(worktreeRoot);
  return worktreeContextFile === undefined
    ? undefined
    : join(mainRepoRoot, basename(worktreeContextFile.path));
}

export async function discoverContextFiles(options: PromptContextOptions): Promise<ContextFile[]> {
  const found: ContextFile[] = [];
  const seen = new Set<string>();

  if (options.globalDir !== undefined) {
    const globalFile = await loadContextFileFromDir(options.globalDir);
    if (globalFile !== undefined) {
      seen.add(pathKey(await canonicalizePath(globalFile.path)));
      found.push(globalFile);
    }
  }

  const workspaces: { resolved: string; canonical: string }[] = [];
  const seenWorkspaces = new Set<string>();
  for (const workspace of options.workspaces ?? []) {
    const resolved = resolve(workspace);
    const canonical = await canonicalizePath(resolved);
    const key = pathKey(canonical);
    if (seenWorkspaces.has(key)) continue;
    seenWorkspaces.add(key);
    workspaces.push({ resolved, canonical });
  }
  const multipleWorkspaces = workspaces.length > 1;

  for (const workspace of workspaces) {
    const shadowedContextFile = await findShadowedContextFile(workspace.resolved);
    for (const dir of ancestorsOf(workspace.resolved)) {
      const candidate = await loadContextFileFromDir(dir);
      if (candidate === undefined) continue;
      const canonicalDir = await canonicalizePath(dir);
      // Compare the directory's real path: a worktree context file symlinked to the main repo resolves to the shadowed path.
      const isShadowed =
        shadowedContextFile !== undefined &&
        pathsEqual(join(canonicalDir, basename(candidate.path)), shadowedContextFile);
      if (isShadowed) continue;

      const canonical = pathKey(await canonicalizePath(candidate.path));
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
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (parsed === null || parsed === undefined) return { frontmatter: {} };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { frontmatter: {}, error: "Skill frontmatter must be a YAML object" };
  }

  const record = parsed as Record<string, unknown>;
  const rawName = record.name;
  const rawDescription = record.description;
  const rawDisableModelInvocation = record["disable-model-invocation"];

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

type IgnoreRule = {
  readonly base: string;
  readonly matcher: Ignore;
};

function isIgnoredByRules(
  rules: readonly IgnoreRule[],
  relativePath: string,
  directory: boolean,
): boolean {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (rule === undefined) continue;
    let relative: string;
    if (rule.base === "") {
      relative = relativePath;
    } else if (relativePath.startsWith(`${rule.base}/`)) {
      relative = relativePath.slice(rule.base.length + 1);
    } else {
      continue;
    }
    if (relative === "") continue;
    const result = rule.matcher.test(directory ? `${relative}/` : relative);
    if (result.ignored) return true;
    if (result.unignored) return false;
  }
  return false;
}

async function readIgnoreRules(dir: string, base: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const filename of IGNORE_FILENAMES) {
    const raw = await readTextFile(join(dir, filename));
    if (raw === undefined || raw.trim() === "") continue;
    rules.push({ base, matcher: ignore().add(raw) });
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

function workspaceAncestors(workspace: string, repoDir?: string): string[] {
  const chain: string[] = [];
  let current = resolve(workspace);
  while (true) {
    chain.push(current);
    if (repoDir !== undefined && pathsEqual(current, repoDir)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
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

export async function discoverSkillsWithDiagnostics(options: PromptContextOptions): Promise<{
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
  const globalSkillsDirKey =
    globalSkillsDir === undefined ? undefined : pathKey(await canonicalizePath(globalSkillsDir));
  // Never treat the host ~/.agents/skills as a workspace skill when walking non-git temp/home ancestors.
  const hostGlobalSkillsDirKey = pathKey(
    await canonicalizePath(join(resolve(homedir()), AGENTS_SKILLS_DIR)),
  );

  const scannedRoots = new Set<string>();
  const seenWorkspaces = new Set<string>();

  for (const rawWorkspace of options.workspaces ?? []) {
    const workspace = resolve(rawWorkspace);
    const wsCanonicalKey = pathKey(await canonicalizePath(workspace));
    if (seenWorkspaces.has(wsCanonicalKey)) continue;
    seenWorkspaces.add(wsCanonicalKey);

    const gitPaths = await findGitPaths(workspace);
    for (const dir of workspaceAncestors(workspace, gitPaths?.repoDir)) {
      const skillsDir = join(dir, AGENTS_SKILLS_DIR);
      const info = await statTarget(skillsDir);
      if (info?.isDirectory() !== true) continue;
      const canonicalRootKey = pathKey(await canonicalizePath(skillsDir));
      if (
        canonicalRootKey === hostGlobalSkillsDirKey ||
        (globalSkillsDirKey !== undefined && canonicalRootKey === globalSkillsDirKey)
      ) {
        continue;
      }
      if (scannedRoots.has(canonicalRootKey)) continue;
      scannedRoots.add(canonicalRootKey);
      await scanSkillsRoot(skillsDir, "workspace", workspace, state);
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

export async function discoverSkills(options: PromptContextOptions): Promise<SkillInfo[]> {
  const result = await discoverSkillsWithDiagnostics(options);
  return [...result.skills];
}

export async function discoverContext(options: PromptContextOptions): Promise<ContextDiscovery> {
  const [contextFiles, skillsResult] = await Promise.all([
    discoverContextFiles(options),
    discoverSkillsWithDiagnostics(options),
  ]);
  return {
    contextFiles,
    skills: skillsResult.skills,
    skillDiagnostics: skillsResult.diagnostics,
  };
}
