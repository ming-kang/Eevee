import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createIgnoreRule, type IgnoreRule, isIgnoredByRules } from "@eevee/agent";
import type { UserInput } from "@eevee/core";
import {
  filePartText,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  type MessageAttachment,
  type WorkspaceFile,
} from "@eevee/protocol";
import { EngineError } from "./engine-error.ts";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
]);
const MAX_DEPTH = 10;
const MAX_SCAN = 15_000;
const DEFAULT_SEARCH_LIMIT = 30;
const MAX_SEARCH_LIMIT = 100;

const EXT_MIME: Readonly<Record<string, string>> = {
  c: "text/x-c",
  cc: "text/x-c++",
  cpp: "text/x-c++",
  cs: "text/x-csharp",
  css: "text/css",
  csv: "text/csv",
  go: "text/x-go",
  graphql: "text/x-graphql",
  h: "text/x-c",
  hpp: "text/x-c++",
  htm: "text/html",
  html: "text/html",
  ini: "text/plain",
  java: "text/x-java",
  js: "text/javascript",
  json: "application/json",
  jsonl: "application/jsonl",
  jsx: "text/jsx",
  kt: "text/x-kotlin",
  lock: "text/plain",
  log: "text/plain",
  lua: "text/x-lua",
  md: "text/markdown",
  mdx: "text/markdown",
  mjs: "text/javascript",
  mts: "text/typescript",
  php: "text/x-php",
  py: "text/x-python",
  rb: "text/x-ruby",
  rs: "text/x-rust",
  sh: "text/x-sh",
  sql: "text/x-sql",
  swift: "text/x-swift",
  toml: "text/x-toml",
  ts: "text/typescript",
  tsx: "text/tsx",
  txt: "text/plain",
  vue: "text/x-vue",
  xml: "text/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  zig: "text/x-zig",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  wasm: "application/wasm",
  zip: "application/zip",
};

export function mimeForPath(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

function isContainedIn(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

export async function resolveInsideWorkspace(root: string, relPath: string): Promise<string> {
  if (relPath.length === 0 || relPath.includes("\0") || isAbsolute(relPath)) {
    throw new EngineError(400, "invalid_path", `Invalid workspace file path: ${relPath}`);
  }
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relPath);
  if (!isContainedIn(resolvedRoot, candidate)) {
    throw new EngineError(400, "invalid_path", `Path escapes workspace: ${relPath}`);
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    [realRoot, realCandidate] = await Promise.all([realpath(resolvedRoot), realpath(candidate)]);
  } catch {
    throw new EngineError(404, "file_not_found", `Workspace file not found: ${relPath}`);
  }
  if (!isContainedIn(realRoot, realCandidate)) {
    throw new EngineError(400, "invalid_path", `Symlink escapes workspace: ${relPath}`);
  }
  return realCandidate;
}

type SearchHit = {
  readonly file: WorkspaceFile;
  readonly rank: number;
  readonly depth: number;
  readonly absPath: string;
};

async function readIgnoreRule(dir: string, relBase: string): Promise<IgnoreRule | undefined> {
  try {
    const raw = await readFile(join(dir, ".gitignore"), "utf8");
    return createIgnoreRule(relBase, raw);
  } catch {
    return undefined;
  }
}

function rankOf(name: string, relPath: string, needle: string): number | undefined {
  if (needle === "") return 1;
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  return relPath.includes(needle) ? 2 : undefined;
}

async function scanWorkspace(
  root: string,
  workspace: number,
  prefixed: boolean,
  needle: string,
  limit: number,
  hits: SearchHit[],
): Promise<void> {
  const resolvedRoot = resolve(root);
  const rootName = basename(resolvedRoot);
  const rootIgnore = await readIgnoreRule(resolvedRoot, "");
  const initialRules: readonly IgnoreRule[] = rootIgnore ? [rootIgnore] : [];
  const queue: { dir: string; relDir: string; depth: number; rules: readonly IgnoreRule[] }[] = [
    { dir: resolvedRoot, relDir: "", depth: 0, rules: initialRules },
  ];
  let scanned = 0;

  while (scanned < MAX_SCAN && hits.length < limit * 4) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current.depth > MAX_DEPTH) continue;
    const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) continue;
    scanned += entries.length;

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relPath = current.relDir === "" ? entry.name : `${current.relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (isIgnoredByRules(current.rules, relPath, true)) continue;
        const childDir = join(current.dir, entry.name);
        const childIgnore = await readIgnoreRule(childDir, relPath);
        const nextRules = childIgnore ? [...current.rules, childIgnore] : current.rules;
        queue.push({ dir: childDir, relDir: relPath, depth: current.depth + 1, rules: nextRules });
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnoredByRules(current.rules, relPath, false)) continue;

      const label = prefixed ? `${rootName}/${relPath}` : relPath;
      const rank = rankOf(entry.name.toLowerCase(), label.toLowerCase(), needle);
      if (rank === undefined) continue;
      const dir = prefixed
        ? current.relDir === ""
          ? rootName
          : `${rootName}/${current.relDir}`
        : current.relDir;
      hits.push({
        rank,
        depth: current.depth,
        absPath: join(current.dir, entry.name),
        file: {
          workspace,
          path: relPath,
          name: entry.name,
          dir,
          label,
          mimeType: mimeForPath(entry.name),
          size: 0,
        },
      });
      if (hits.length >= limit * 4) break;
    }
  }
}

export async function searchWorkspaceFiles(
  workspaces: readonly string[],
  query = "",
  limit = DEFAULT_SEARCH_LIMIT,
): Promise<WorkspaceFile[]> {
  const clampedLimit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit)));
  const needle = query
    .trim()
    .toLowerCase()
    .replace(/^[./\\]+/, "")
    .replaceAll("\\", "/");
  const hits: SearchHit[] = [];
  await Promise.all(
    workspaces.map((root, index) =>
      scanWorkspace(root, index, workspaces.length > 1, needle, clampedLimit, hits),
    ),
  );
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.depth - b.depth ||
      a.file.name.length - b.file.name.length ||
      a.file.label.localeCompare(b.file.label),
  );
  const selected = hits.slice(0, clampedLimit);
  return Promise.all(
    selected.map(async (hit) => {
      const size = await stat(hit.absPath)
        .then((info) => info.size)
        .catch(() => 0);
      return { ...hit.file, size };
    }),
  );
}

export type ResolvedFileMention = {
  readonly workspace: number;
  readonly path: string;
};

const AT_TOKEN = /(^|\s)@("[^"]+"|[^\s@]+)/g;
const REF_TOKEN = /^[wt]\d+$/i;
const FILE_SCOPE_PREFIX = /^files?:/i;
const TRAILING_PUNCT = /[.,;:!?)\]]+$/;

function mentionCandidates(raw: string): string[] {
  const token = raw.replace(/^[./\\]+/, "").replaceAll("\\", "/");
  if (token === "" || REF_TOKEN.test(token)) return [];
  const out = [token];
  const unprefixed = token.replace(FILE_SCOPE_PREFIX, "");
  if (unprefixed !== token && unprefixed !== "") out.push(unprefixed);
  let trimmed = unprefixed;
  while (TRAILING_PUNCT.test(trimmed)) {
    trimmed = trimmed.replace(TRAILING_PUNCT, "");
    if (trimmed !== "") out.push(trimmed);
  }
  return [...new Set(out)];
}

async function resolveUniqueWorkspaceFile(
  workspaces: readonly string[],
  token: string,
): Promise<ResolvedFileMention | undefined> {
  const hits: ResolvedFileMention[] = [];
  const multi = workspaces.length > 1;
  for (const [workspace, root] of workspaces.entries()) {
    const prefixed = `${basename(resolve(root))}/`;
    const candidates = multi
      ? token.startsWith(prefixed)
        ? [token.slice(prefixed.length), token]
        : [token]
      : token.startsWith(prefixed)
        ? [token, token.slice(prefixed.length)]
        : [token];
    for (const candidatePath of candidates) {
      if (candidatePath.length === 0) continue;
      try {
        const abs = await resolveInsideWorkspace(root, candidatePath);
        const info = await stat(abs);
        if (info.isFile()) {
          hits.push({ workspace, path: candidatePath });
          break;
        }
      } catch {}
    }
  }
  return hits.length === 1 ? hits[0] : undefined;
}

export async function resolveFileMentions(
  text: string,
  workspaces: readonly string[],
): Promise<ResolvedFileMention[]> {
  if (!text.includes("@") || workspaces.length === 0) return [];
  const mentions: ResolvedFileMention[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(AT_TOKEN)) {
    const raw = match[2] ?? "";
    const token = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    for (const candidate of mentionCandidates(token)) {
      const hit = await resolveUniqueWorkspaceFile(workspaces, candidate);
      if (hit === undefined) continue;
      const key = `${hit.workspace}:${hit.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push(hit);
      }
      break;
    }
  }
  return mentions;
}

export type ReadWorkspaceFileResult = {
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
  readonly size: number;
};

function sniffMime(filePath: string, bytes: Uint8Array): string {
  const guessed = mimeForPath(filePath);
  if (guessed !== "application/octet-stream") return guessed;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "text/plain";
  } catch {
    return guessed;
  }
}

export async function readWorkspaceFile(
  workspaces: readonly string[],
  workspaceIndex: number,
  relPath: string,
): Promise<ReadWorkspaceFileResult> {
  const root = workspaces[workspaceIndex];
  if (root === undefined) {
    throw new EngineError(400, "invalid_workspace", `Unknown workspace index ${workspaceIndex}`);
  }
  const abs = await resolveInsideWorkspace(root, relPath);
  const info = await stat(abs).catch(() => {
    throw new EngineError(404, "file_not_found", `Workspace file not found: ${relPath}`);
  });
  if (!info.isFile()) {
    throw new EngineError(400, "invalid_path", `Workspace path is not a file: ${relPath}`);
  }
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new EngineError(
      413,
      "attachment_too_large",
      `Attachment "${relPath}" exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
    );
  }
  const bytes = await readFile(abs);
  return {
    name: basename(abs),
    mimeType: sniffMime(abs, bytes),
    data: bytes.toString("base64"),
    size: info.size,
  };
}

function decodeBase64Bytes(data: string): number {
  const clean = data.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new EngineError(400, "invalid_attachment", "Attachment data must be valid base64");
  }
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return (clean.length / 4) * 3 - pad;
}

function toContentPart(input: {
  readonly name?: string;
  readonly mimeType: string;
  readonly data: string;
  readonly size: number;
  readonly path?: string;
}): TextContent | ImageContent {
  if (input.mimeType.startsWith("image/")) {
    return { type: "image", data: input.data, mimeType: input.mimeType };
  }
  return {
    type: "text",
    text: filePartText(input),
  };
}

export async function buildUserMessageContent(options: {
  readonly text: string;
  readonly attachments?: readonly MessageAttachment[];
  readonly workspaces: readonly string[];
}): Promise<UserInput> {
  const attachments = options.attachments ?? [];
  if (options.text.trim().length === 0 && attachments.length === 0) {
    throw new EngineError(400, "invalid_request", "Message must include text or attachments");
  }
  if (attachments.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new EngineError(
      400,
      "too_many_attachments",
      `At most ${MAX_MESSAGE_ATTACHMENTS} attachments are allowed`,
    );
  }

  const parts: (TextContent | ImageContent)[] = [];
  const seenWorkspacePaths = new Set<string>();

  for (const attachment of attachments) {
    if (attachment.kind === "inline") {
      const size = decodeBase64Bytes(attachment.data);
      if (size > MAX_ATTACHMENT_BYTES) {
        throw new EngineError(
          413,
          "attachment_too_large",
          `Attachment "${attachment.name ?? "file"}" exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
        );
      }
      parts.push(
        toContentPart({
          ...(attachment.name === undefined ? {} : { name: attachment.name }),
          mimeType: attachment.mimeType,
          data: attachment.data.replace(/\s+/g, ""),
          size,
        }),
      );
      continue;
    }

    const key = `${attachment.workspace}:${attachment.path}`;
    if (seenWorkspacePaths.has(key)) continue;
    seenWorkspacePaths.add(key);
    const file = await readWorkspaceFile(options.workspaces, attachment.workspace, attachment.path);
    parts.push(
      toContentPart({
        name: attachment.name ?? file.name,
        mimeType: attachment.mimeType ?? file.mimeType,
        data: file.data,
        size: file.size,
        path: attachment.path,
      }),
    );
  }

  const mentions = await resolveFileMentions(options.text, options.workspaces);
  for (const mention of mentions) {
    if (parts.length >= MAX_MESSAGE_ATTACHMENTS) break;
    const key = `${mention.workspace}:${mention.path}`;
    if (seenWorkspacePaths.has(key)) continue;
    seenWorkspacePaths.add(key);
    const file = await readWorkspaceFile(options.workspaces, mention.workspace, mention.path);
    parts.push(
      toContentPart({
        name: file.name,
        mimeType: file.mimeType,
        data: file.data,
        size: file.size,
        path: mention.path,
      }),
    );
  }

  if (parts.length === 0) return options.text;
  if (options.text !== "") {
    parts.push({ type: "text", text: options.text });
  }
  return parts;
}
