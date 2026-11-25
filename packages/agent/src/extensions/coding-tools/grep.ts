import type { Context } from "@earendil-works/chord/context";
import { defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { arr, bool, int, num, obj, opt, str } from "@earendil-works/pi-schema";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
} from "../../shared/truncate.ts";
import { matchGlob, walkFiles } from "./listings.ts";

const DEFAULT_LIMIT = 100;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

const grepStructuredOutput = obj({
  matches: arr(obj({ path: str(), line: num(), text: str() })),
  truncated: bool(),
  matchLimitReached: opt(num()),
});

function errorResult(text: string) {
  return { output: [{ type: "text" as const, text }], isError: true };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Row = {
  readonly line: number;
  readonly text: string;
  readonly match: boolean;
};

function scanRows(lines: readonly string[], expression: RegExp, contextLines: number): Row[] {
  const matchIndexes: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line !== undefined && expression.test(line)) matchIndexes.push(index);
  }
  if (matchIndexes.length === 0) return [];
  const types = new Map<number, boolean>();
  for (const matchIndex of matchIndexes) {
    const from = Math.max(0, matchIndex - contextLines);
    const to = Math.min(lines.length - 1, matchIndex + contextLines);
    for (let line = from; line <= to; line++) {
      if (line === matchIndex) {
        types.set(line, true);
      } else if (!types.has(line)) {
        types.set(line, false);
      }
    }
  }
  const rows: Row[] = [];
  for (const [line, match] of [...types.entries()].sort((a, b) => a[0] - b[0])) {
    const text = lines[line];
    if (text !== undefined) rows.push({ line: line + 1, text, match });
  }
  return rows;
}

async function readSearchableLines(
  env: ExecutionEnv,
  path: string,
  context: Context,
): Promise<{ lines: string[] } | { skipped: "binary" | "oversize" | "unreadable" }> {
  const info = await env.fileInfo(path, context);
  if (!info.ok) return { skipped: "unreadable" };
  if (info.value.size > MAX_FILE_BYTES) return { skipped: "oversize" };
  const binary = await env.readBinaryFile(path, context);
  if (!binary.ok) return { skipped: "unreadable" };
  const probe = binary.value.subarray(0, Math.min(binary.value.length, 8192));
  for (const byte of probe) {
    if (byte === 0) return { skipped: "binary" };
  }
  return { lines: new TextDecoder().decode(binary.value).split("\n") };
}

export const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.",
  parameters: obj({
    pattern: str({ description: "Search pattern (regex or literal string)" }),
    path: opt(str({ description: "Directory or file to search (default: current directory)" })),
    glob: opt(
      str({
        description:
          "Filter files by glob pattern relative to path, e.g. 'src/**/*.ts'. Without '/', e.g. '*.ts', it matches file names at any depth",
      }),
    ),
    ignoreCase: opt(bool({ description: "Case-insensitive search (default: false)" })),
    literal: opt(
      bool({ description: "Treat pattern as literal string instead of regex (default: false)" }),
    ),
    context: opt(
      int({ minimum: 0, description: "Lines to show before and after each match (default: 0)" }),
    ),
    limit: opt(
      int({ minimum: 1, description: "Maximum number of matches to return (default: 100)" }),
    ),
  }),
  replay: "safe",
  structuredOutputSchema: grepStructuredOutput,
  execute: async (args, api, context) => {
    const env = api.env;
    if (env === undefined) {
      return errorResult(
        "This tool needs a workspace environment, which this conversation does not have.",
      );
    }
    let expression: RegExp;
    try {
      const source = args.literal === true ? escapeRegExp(args.pattern) : args.pattern;
      expression = new RegExp(source, args.ignoreCase === true ? "i" : "");
    } catch (error) {
      return errorResult(`Invalid regular expression: ${(error as Error).message}`);
    }
    const effectiveLimit = Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT));
    const contextLines = Math.max(0, Math.floor(args.context ?? 0));

    const resolved = await env.absolutePath(args.path ?? ".", context);
    if (!resolved.ok) return errorResult(resolved.error.message);
    const info = await env.fileInfo(resolved.value, context);
    if (!info.ok) return errorResult(`Path not found: ${resolved.value}`);

    const targets: { path: string; display: string }[] = [];
    let listingTruncated = false;
    if (info.value.kind === "file") {
      targets.push({ path: resolved.value, display: resolved.value });
    } else if (info.value.kind === "directory") {
      const listing = await walkFiles(env, args.path ?? ".", context);
      if (!listing.ok) return errorResult(listing.error);
      listingTruncated = listing.truncated;
      for (const entry of listing.entries) {
        if (entry.kind !== "file") continue;
        if (args.glob !== undefined && !matchGlob(args.glob, entry.path)) continue;
        const joined = await env.joinPath([resolved.value, ...entry.path.split("/")], context);
        targets.push({
          path: joined.ok ? joined.value : `${resolved.value}/${entry.path}`,
          display: entry.path,
        });
      }
    } else {
      return errorResult(`Not a file or directory: ${resolved.value}`);
    }

    const emitted: string[] = [];
    const matchesOut: { path: string; line: number; text: string }[] = [];
    let matchCount = 0;
    let limitHit = false;
    let trailingContextEnd = -1;
    let lastFile: string | undefined;
    let matchLimitReached = false;
    let linesTruncated = false;
    let oversizeSkipped = 0;
    let doneScanning = false;

    const pushRow = (display: string, row: Row, asMatch: boolean) => {
      const sanitized = row.text.replace(/\r?\n?$/, "");
      const truncated = truncateLine(sanitized);
      if (truncated.wasTruncated) linesTruncated = true;
      const rendered = asMatch
        ? `${display}:${row.line}: ${truncated.text}`
        : `${display}-${row.line}- ${truncated.text}`;
      emitted.push(rendered);
      if (asMatch) matchesOut.push({ path: display, line: row.line, text: truncated.text });
    };

    for (const target of targets) {
      if (doneScanning) break;
      if (limitHit && matchLimitReached) break;
      const read = await readSearchableLines(env, target.path, context);
      if ("skipped" in read) {
        if (read.skipped === "oversize") oversizeSkipped += 1;
        continue;
      }
      if (limitHit) {
        if (read.lines.some((line) => expression.test(line))) {
          matchLimitReached = true;
          break;
        }
        continue;
      }
      const rows = scanRows(read.lines, expression, contextLines);
      for (const row of rows) {
        const inWindow = limitHit && target.display === lastFile && row.line <= trailingContextEnd;
        if (!limitHit) {
          pushRow(target.display, row, row.match);
          if (row.match) {
            matchCount += 1;
            lastFile = target.display;
            if (matchCount >= effectiveLimit) {
              limitHit = true;
              trailingContextEnd = row.line + contextLines;
            }
          }
          continue;
        }
        if (inWindow) {
          pushRow(target.display, row, false);
          continue;
        }
        if (row.match) {
          matchLimitReached = true;
          doneScanning = true;
          break;
        }
      }
    }

    if (matchCount === 0) {
      return {
        output: [{ type: "text" as const, text: "No matches found" }],
        structuredOutput: { matches: [], truncated: false },
      };
    }
    const truncation = truncateHead(emitted.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    let output = truncation.content;
    const notices: string[] = [];
    const details: {
      truncation?: ReturnType<typeof truncateHead>;
      matchLimitReached?: number;
      linesTruncated?: boolean;
    } = {};
    if (matchLimitReached) {
      notices.push(
        `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
      );
      details.matchLimitReached = effectiveLimit;
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      details.truncation = truncation;
    }
    if (linesTruncated) {
      notices.push("Some lines truncated to 500 chars. Use read tool to see full lines");
      details.linesTruncated = true;
    }
    if (oversizeSkipped > 0) {
      notices.push(`${oversizeSkipped} files over ${formatSize(MAX_FILE_BYTES)} skipped`);
    }
    if (listingTruncated) {
      notices.push("directory listing truncated before every entry was seen");
    }
    if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
    return {
      output: [{ type: "text" as const, text: output }],
      structuredOutput: {
        matches: matchesOut,
        truncated: truncation.truncated,
        ...(matchLimitReached ? { matchLimitReached: effectiveLimit } : {}),
      },
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
  },
});
