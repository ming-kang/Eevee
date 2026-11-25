import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, int, num, obj, opt, str } from "@earendil-works/pi-schema";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../../shared/truncate.ts";
import { matchGlob, walkFiles } from "./listings.ts";

const DEFAULT_LIMIT = 1000;

const findStructuredOutput = obj({
  paths: arr(str()),
  truncated: bool(),
  resultLimitReached: opt(num()),
});

function errorResult(text: string) {
  return { output: [{ type: "text" as const, text }], isError: true };
}

export const findTool = defineTool({
  name: "find",
  description:
    "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
  parameters: obj({
    pattern: str({
      description:
        "Glob pattern relative to the search directory, e.g. 'src/**/*.ts'. Without '/', e.g. '*.ts', it matches file names at any depth",
    }),
    path: opt(str({ description: "Directory to search in (default: current directory)" })),
    limit: opt(int({ minimum: 1, description: "Maximum number of results (default: 1000)" })),
  }),
  replay: "safe",
  structuredOutputSchema: findStructuredOutput,
  execute: async (args, api, context) => {
    const env = api.env;
    if (env === undefined) {
      return errorResult(
        "This tool needs a workspace environment, which this conversation does not have.",
      );
    }
    const effectiveLimit = Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT));
    const listing = await walkFiles(env, args.path ?? ".", context);
    if (!listing.ok) return errorResult(listing.error);

    const matched: string[] = [];
    let resultLimitReached = false;
    for (const entry of listing.entries) {
      if (!matchGlob(args.pattern, entry.path)) continue;
      if (matched.length >= effectiveLimit) {
        resultLimitReached = true;
        break;
      }
      matched.push(entry.kind === "directory" ? `${entry.path}/` : entry.path);
    }

    if (matched.length === 0) {
      return {
        output: [{ type: "text" as const, text: "No files found matching pattern" }],
        structuredOutput: { paths: [], truncated: false },
      };
    }
    const truncation = truncateHead(matched.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    let output = truncation.content;
    const notices: string[] = [];
    const details: {
      truncation?: ReturnType<typeof truncateHead>;
      resultLimitReached?: number;
    } = {};
    if (resultLimitReached) {
      notices.push(`${effectiveLimit} results limit reached`);
      details.resultLimitReached = effectiveLimit;
    }
    if (listing.truncated) {
      notices.push("directory listing truncated before every entry was seen");
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      details.truncation = truncation;
    }
    if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
    return {
      output: [{ type: "text" as const, text: output }],
      structuredOutput: {
        paths: matched,
        truncated: truncation.truncated,
        ...(resultLimitReached ? { resultLimitReached: effectiveLimit } : {}),
      },
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
  },
});
