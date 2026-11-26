import type { Stats } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
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

export type ContextFile = {
  readonly path: string;
  readonly content: string;
  readonly workspace?: string;
};

export type SkillInfo = {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: "global" | "workspace";
  readonly disableModelInvocation: boolean;
};

export type ContextDiscovery = {
  readonly contextFiles: readonly ContextFile[];
  readonly skills: readonly SkillInfo[];
};

export type PromptContextOptions = {
  readonly globalDir?: string;
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

export function parseSkillFrontmatter(text: string): {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
} {
  const normalized = stripBom(text).replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return {};
  const frontmatter = normalized.slice(4, end);
  const result: { name?: string; description?: string; disableModelInvocation?: boolean } = {};
  for (const line of frontmatter.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const raw = match[2] ?? "";
    const value = raw.replace(/^["']|["']$/g, "").trim();
    if (key === "disable-model-invocation") {
      result.disableModelInvocation = value === "true";
      continue;
    }
    if (value === "") continue;
    if (key === "name") result.name = value;
    if (key === "description") result.description = value;
  }
  return result;
}

async function scanSkillsDir(dir: string, source: "global" | "workspace"): Promise<SkillInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const entry of entries.sort()) {
    const path = join(dir, entry, SKILL_FILE);
    if (!(await isFile(path))) continue;
    const text = await readTextFile(path);
    if (text === undefined) continue;
    const frontmatter = parseSkillFrontmatter(text);
    skills.push({
      name: frontmatter.name ?? entry,
      description: frontmatter.description ?? "",
      path,
      source,
      disableModelInvocation: frontmatter.disableModelInvocation === true,
    });
  }
  return skills;
}

export async function discoverSkills(options: PromptContextOptions): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  const seenPaths = new Set<string>();
  const add = async (dir: string, source: "global" | "workspace") => {
    for (const skill of await scanSkillsDir(dir, source)) {
      if (seen.has(skill.name) || seenPaths.has(skill.path)) continue;
      skills.push(skill);
      seen.add(skill.name);
      seenPaths.add(skill.path);
    }
  };

  if (options.globalDir !== undefined) {
    await add(join(options.globalDir, SKILLS_DIR), "global");
    await add(join(options.globalDir, AGENTS_SKILLS_DIR), "global");
  }

  for (const workspace of options.workspaces ?? []) {
    const chain = ancestorsOf(workspace);
    await add(join(workspace, PI_SKILLS_DIR), "workspace");
    for (const dir of [...chain].reverse()) {
      await add(join(dir, AGENTS_SKILLS_DIR), "workspace");
    }
  }

  return skills;
}

export async function discoverContext(options: PromptContextOptions): Promise<ContextDiscovery> {
  const [contextFiles, skills] = await Promise.all([
    discoverContextFiles(options),
    discoverSkills(options),
  ]);
  return { contextFiles, skills };
}
