import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createIgnoreRule, type IgnoreRule, isIgnoredByRules } from "../../shared/ignore.ts";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "../../shared/truncate.ts";

export type WalkEntry = {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
};

export type WalkResult =
  | { ok: true; entries: WalkEntry[]; truncated: boolean }
  | { ok: false; error: string };

export const WALK_MAX_ENTRIES = 50000;

export function formatTruncatedListing(
  lines: readonly string[],
  notices: readonly string[] = [],
): { readonly text: string; readonly truncation: TruncationResult } {
  const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const allNotices = [...notices];
  if (truncation.truncated) {
    allNotices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  const text =
    allNotices.length > 0
      ? `${truncation.content}\n\n[${allNotices.join(". ")}]`
      : truncation.content;
  return { text, truncation };
}

async function readGitignore(
  env: ExecutionEnv,
  dir: string,
  base: string,
  context: Context,
): Promise<IgnoreRule | undefined> {
  const joined = await env.joinPath([dir, ".gitignore"], context);
  if (!joined.ok) return undefined;
  const content = await env.readTextFile(joined.value, context);
  if (!content.ok) return undefined;
  return createIgnoreRule(base, content.value);
}

export async function walkFiles(
  env: ExecutionEnv,
  path: string,
  context: Context,
  options: { maxEntries?: number; respectGitignore?: boolean } = {},
): Promise<WalkResult> {
  const resolved = await env.absolutePath(path === "" ? "." : path, context);
  if (!resolved.ok) return { ok: false, error: resolved.error.message };
  const root = resolved.value;
  const info = await env.fileInfo(root, context);
  if (!info.ok) return { ok: false, error: info.error.message };
  if (info.value.kind !== "directory") {
    return { ok: false, error: `Not a directory: ${root}` };
  }

  const maxEntries = options.maxEntries ?? WALK_MAX_ENTRIES;
  const respectGitignore = options.respectGitignore !== false;
  const entries: WalkEntry[] = [];
  let truncated = false;

  const rootRules: IgnoreRule[] = [];
  if (respectGitignore) {
    const rootRule = await readGitignore(env, root, "", context);
    if (rootRule !== undefined) rootRules.push(rootRule);
  }

  async function descend(
    dir: string,
    base: string,
    inherited: readonly IgnoreRule[],
  ): Promise<void> {
    if (truncated) return;
    let rules = inherited;
    if (respectGitignore && base !== "") {
      const rule = await readGitignore(env, dir, base, context);
      if (rule !== undefined) rules = [...inherited, rule];
    }
    const listing = await env.listDir(dir, context);
    if (!listing.ok) return;
    for (const entry of [...listing.value].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (truncated) return;
      if (entry.name === ".git") continue;
      const relative = base === "" ? entry.name : `${base}/${entry.name}`;
      if (respectGitignore && isIgnoredByRules(rules, relative, entry.kind === "directory")) {
        continue;
      }
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      entries.push({ path: relative, kind: entry.kind });
      if (entry.kind === "directory") {
        const joined = await env.joinPath([dir, entry.name], context);
        await descend(joined.ok ? joined.value : `${dir}/${entry.name}`, relative, rules);
      }
    }
  }

  await descend(root, "", rootRules);
  return { ok: true, entries, truncated };
}

export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else {
      const char = pattern[index];
      if (char === "*") {
        source += "[^/]*";
      } else if (char === "?") {
        source += "[^/]";
      } else if (char !== undefined && "\\^$.|+()[]{}".includes(char)) {
        source += `\\${char}`;
      } else {
        source += char;
      }
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchGlob(pattern: string, path: string): boolean {
  const cleaned = pattern.replace(/^\.\//, "");
  if (!cleaned.includes("/")) {
    const segments = path.split("/");
    const basename = segments[segments.length - 1] ?? path;
    return globToRegExp(cleaned).test(basename);
  }
  return globToRegExp(cleaned).test(path);
}
