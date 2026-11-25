import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const CONTEXT_FILE = "AGENTS.md";
export const SKILL_FILE = "SKILL.md";
export const SKILLS_DIR = "skills";
export const PI_SKILLS_DIR = ".pi/skills";
export const AGENTS_SKILLS_DIR = ".agents/skills";

export type ContextFile = {
  readonly path: string;
  readonly content: string;
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

export async function discoverContextFiles(options: PromptContextOptions): Promise<ContextFile[]> {
  const found: ContextFile[] = [];
  const seen = new Set<string>();

  if (options.globalDir !== undefined) {
    const globalFile = join(options.globalDir, CONTEXT_FILE);
    const content = await readTextFile(globalFile);
    if (content !== undefined) {
      found.push({ path: globalFile, content });
      seen.add(globalFile);
    }
  }

  for (const workspace of options.workspaces ?? []) {
    for (const dir of ancestorsOf(workspace)) {
      const candidate = join(dir, CONTEXT_FILE);
      if (seen.has(candidate)) continue;
      const content = await readTextFile(candidate);
      if (content !== undefined) {
        found.push({ path: candidate, content });
        seen.add(candidate);
      }
    }
  }

  return found;
}

export function parseSkillFrontmatter(text: string): {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
} {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
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
