import { resolveSchemaRef } from "@earendil-works/pi-codemode/declarations";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolNamespace,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { namespacesOf } from "@earendil-works/pi-durable/codemode";
import {
  DEFAULT_TOOL_SEARCH_LIMIT,
  TOOL_SEARCH_TOOL_NAME,
  type ToolSearchToolDetails,
} from "@earendil-works/pi-durable/tool-search";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { withToolPromptMeta } from "../../context/tool-meta.ts";
import { isRecord } from "../../shared/guards.ts";

export type { ToolSearchToolDetails };
export { DEFAULT_TOOL_SEARCH_LIMIT, TOOL_SEARCH_TOOL_NAME };

export const TOOL_SEARCH_EXTENSION = "eevee.tool-search";

const TOOL_SEARCH_DESCRIPTION = `# Tool discovery

Searches over deferred tool metadata with BM25 and exposes matching tools for the next model call.

Some of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`;

const toolSearchSchema = obj(
  {
    query: str({ description: "Search query for deferred tools." }),
    limit: opt(
      num({
        description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.`,
      }),
    ),
  },
  { open: true },
);

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const NAME_WEIGHT = 3;
const NAMESPACE_WEIGHT = 0.75;

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

function tokenize(text: string): string[] {
  const normalized = text
    .normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
  const words = /^[a-z0-9 ]*$/.test(normalized)
    ? normalized.split(" ")
    : Array.from(wordSegmenter.segment(normalized), (segment) =>
        segment.isWordLike ? segment.segment : "",
      );
  return words
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word))
    .map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word));
}

function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_$]/g, "_");
}

function isExactNameQuery(query: string, name: string): boolean {
  const normalized = normalizeName(name);
  return normalized === query || normalized.endsWith(`__${query}`);
}

type SearchDoc = {
  readonly name: string;
  readonly text: string;
  readonly namespaceText: string;
};

type IndexedDoc = {
  readonly name: string;
  readonly nameTerms: ReadonlySet<string>;
  readonly localNameTerms: readonly string[];
  readonly textCounts: ReadonlyMap<string, number>;
  readonly textLength: number;
  readonly namespaceTerms: ReadonlySet<string>;
};

function indexDocument(doc: SearchDoc): IndexedDoc {
  const textCounts = new Map<string, number>();
  for (const term of tokenize(doc.text)) {
    textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
  }
  const segments = doc.name.split("__");
  const localSegment = segments[segments.length - 1] ?? doc.name;
  return {
    name: doc.name,
    nameTerms: new Set(tokenize(doc.name)),
    localNameTerms: [...new Set(tokenize(localSegment))],
    textCounts,
    textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
    namespaceTerms: new Set(tokenize(doc.namespaceText)),
  };
}

function rankDeferredTools(query: string, docs: readonly SearchDoc[], limit: number): string[] {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0 || docs.length === 0 || limit <= 0) return [];
  const indexed = docs.map(indexDocument);
  const averageLength = indexed.reduce((sum, doc) => sum + doc.textLength, 0) / indexed.length || 1;
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const frequency = indexed.filter(
      (doc) => doc.nameTerms.has(term) || doc.textCounts.has(term) || doc.namespaceTerms.has(term),
    ).length;
    idf.set(term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5)));
  }
  const fullNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
  const exactQuery = normalizeName(query);

  const matches: { name: string; score: number; covered: number; exact: boolean }[] = [];
  for (const doc of indexed) {
    const norm = BM25_K1 * (1 - BM25_B + (BM25_B * doc.textLength) / averageLength);
    let score = 0;
    let covered = 0;
    for (const term of queryTerms) {
      const count = doc.textCounts.get(term) ?? 0;
      const weight =
        (doc.nameTerms.has(term) ? NAME_WEIGHT : 0) +
        (doc.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
        (count * (BM25_K1 + 1)) / (count + norm);
      if (weight > 0) covered += 1;
      score += (idf.get(term) ?? 0) * weight;
    }
    if (score === 0) continue;
    if (doc.localNameTerms.length > 0 && doc.localNameTerms.every((term) => queryTerms.has(term))) {
      score += fullNameBonus;
    }
    matches.push({
      name: doc.name,
      score,
      covered,
      exact: isExactNameQuery(exactQuery, doc.name),
    });
  }

  return matches
    .sort(
      (left, right) =>
        Number(right.exact) - Number(left.exact) ||
        right.covered - left.covered ||
        right.score - left.score,
    )
    .slice(0, limit)
    .map((match) => match.name);
}

function collectSchemaText(
  schema: unknown,
  root: Record<string, unknown>,
  parts: string[],
  seen: Set<unknown>,
): void {
  if (!isRecord(schema)) return;
  if (typeof schema.$ref === "string") {
    const target = resolveSchemaRef(schema.$ref, root);
    if (isRecord(target) && !seen.has(target)) {
      seen.add(target);
      collectSchemaText(target, root, parts, seen);
    }
  }
  if (typeof schema.description === "string") parts.push(schema.description);
  if (isRecord(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name);
      collectSchemaText(property, root, parts, seen);
    }
  }
  collectSchemaText(schema.items, root, parts, seen);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = schema[key];
    if (Array.isArray(variants)) {
      for (const variant of variants) collectSchemaText(variant, root, parts, seen);
    }
  }
}

function toolSearchText(tool: ToolRegistration): string {
  const parts = [tool.description];
  const root = isRecord(tool.parameters) ? tool.parameters : {};
  collectSchemaText(tool.parameters, root, parts, new Set([tool.parameters]));
  return parts.filter((part) => part.trim() !== "").join(" ");
}

function formatNamespaceText(namespace: ToolNamespace | undefined): string {
  if (namespace === undefined) return "";
  return [namespace.name, namespace.description, namespace.instructions ?? ""]
    .filter((part) => part.trim() !== "")
    .join(" ");
}

export function createToolSearchTool(): ToolRegistration<
  typeof toolSearchSchema,
  ToolSearchToolDetails
> {
  return withToolPromptMeta(
    defineTool({
      name: TOOL_SEARCH_TOOL_NAME,
      description: TOOL_SEARCH_DESCRIPTION,
      parameters: toolSearchSchema,
      callers: ["model"],
      replay: "safe",
      async execute({ query, limit }, api, context) {
        if (query.trim() === "") throw new Error("query must not be empty");
        const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
        if (!Number.isInteger(max) || max <= 0) {
          throw new Error("limit must be a positive integer");
        }
        const agent = await api.agent(context);
        const candidates = agent.deferred;
        const toolNamespaces = namespacesOf(agent.extensions);
        const docs: SearchDoc[] = candidates.map((tool) => ({
          name: tool.name,
          text: toolSearchText(tool),
          namespaceText: formatNamespaceText(toolNamespaces.get(tool.name)),
        }));
        const loaded = rankDeferredTools(query, docs, max);
        const text =
          loaded.length === 0
            ? "No matching tools found."
            : `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:\n${loaded
                .map((name) => {
                  const description =
                    candidates.find((tool) => tool.name === name)?.description ?? "";
                  return `- ${name}: ${description.trim().split(/\r?\n/)[0]}`;
                })
                .join("\n")}`;
        const details: ToolSearchToolDetails = { loaded };
        return {
          output: [{ type: "text", text }],
          details,
          ...(loaded.length === 0 ? {} : { control: { addTools: loaded } }),
        };
      },
    }),
    {
      promptSnippet: "Search for deferred tools that are not loaded yet and load the matches",
      promptGuidelines: [
        "Use tool_search to discover and load deferred tools (including MCP server tools listed in mcp_servers) before calling them directly.",
      ],
    },
  );
}

export function createToolSearchExtension(): Extension {
  return defineExtension({
    name: TOOL_SEARCH_EXTENSION,
    tools: [createToolSearchTool()],
  });
}
