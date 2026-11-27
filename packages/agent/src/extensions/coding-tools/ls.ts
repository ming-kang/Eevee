import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, int, num, obj, opt, str } from "@earendil-works/pi-schema";
import { withToolPromptMeta } from "../../context/tool-meta.ts";
import type { TruncationResult } from "../../shared/truncate.ts";
import { formatTruncatedListing } from "./listings.ts";

const DEFAULT_LIMIT = 500;

const lsStructuredOutput = obj({
  entries: arr(str()),
  truncated: bool(),
  entryLimitReached: opt(num()),
});

export type LsToolDetails = {
  readonly truncation?: TruncationResult;
  readonly entryLimitReached?: number;
};

function errorResult(text: string) {
  return { output: [{ type: "text" as const, text }], isError: true };
}

export const lsTool = withToolPromptMeta(
  defineTool({
    name: "ls",
    description:
      "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
    parameters: obj({
      path: opt(str({ description: "Directory to list (default: current directory)" })),
      limit: opt(
        int({ minimum: 1, description: "Maximum number of entries to return (default: 500)" }),
      ),
    }),
    replay: "safe",
    structuredOutputSchema: lsStructuredOutput,
    execute: async (args, api, context) => {
      const env = api.env;
      if (env === undefined) {
        return errorResult(
          "This tool needs a workspace environment, which this conversation does not have.",
        );
      }
      const effectiveLimit = Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT));
      const resolved = await env.absolutePath(args.path ?? ".", context);
      if (!resolved.ok) return errorResult(resolved.error.message);
      const info = await env.fileInfo(resolved.value, context);
      if (!info.ok) return errorResult(`Path not found: ${resolved.value}`);
      if (info.value.kind !== "directory") return errorResult(`Not a directory: ${resolved.value}`);
      const listing = await env.listDir(resolved.value, context);
      if (!listing.ok) return errorResult(`Cannot read directory: ${listing.error.message}`);

      const names = [...listing.value].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );
      const entries: string[] = [];
      let entryLimitReached = false;
      for (const entry of names) {
        if (entries.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        entries.push(entry.kind === "directory" ? `${entry.name}/` : entry.name);
      }

      if (entries.length === 0) {
        return {
          output: [{ type: "text" as const, text: "(empty directory)" }],
          structuredOutput: { entries: [], truncated: false },
        };
      }
      const notices = entryLimitReached
        ? [`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`]
        : [];
      const { text, truncation } = formatTruncatedListing(entries, notices);
      const details: LsToolDetails = {
        ...(entryLimitReached ? { entryLimitReached: effectiveLimit } : {}),
        ...(truncation.truncated ? { truncation } : {}),
      };
      return {
        output: [{ type: "text" as const, text }],
        structuredOutput: {
          entries,
          truncated: truncation.truncated,
          ...(entryLimitReached ? { entryLimitReached: effectiveLimit } : {}),
        },
        ...(Object.keys(details).length > 0 ? { details } : {}),
      };
    },
  }),
  {
    promptSnippet: "List directory contents",
    promptGuidelines: [
      "Use ls to orient in a directory; it lists entries alphabetically with a '/' suffix for directories.",
    ],
  },
);
