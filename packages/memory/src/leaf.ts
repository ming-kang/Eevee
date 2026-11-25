import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { clipMiddle } from "./text.ts";

export const ZOOM_TOOL = "zoom";
export const SEARCH_TOOL = "search";

export const MEMORY_TOOLS = {
  zoom: ZOOM_TOOL,
  search: SEARCH_TOOL,
} as const;

const LOOKUPS: ReadonlySet<string> = new Set([ZOOM_TOOL, SEARCH_TOOL]);
const EXCLUDED_STOP_REASONS: ReadonlySet<string> = new Set(["aborted", "error", "deferred"]);
const CALL_MARK = "→ ";
const TOOL_OUTPUT_CHARS = 30_000;

export type LeafKind = "user" | "assistant" | "tool";

export type LeafDraft = {
  readonly entry: number;
  readonly kind: LeafKind;
  readonly text: string;
  readonly at: number;
};

export type Leaf = LeafDraft & {
  readonly index: number;
};

const KINDS: Record<Exclude<Message["role"], "system">, LeafKind> = {
  user: "user",
  assistant: "assistant",
  toolResult: "tool",
};

/**
 * Normalize one transcript entry into a memory leaf, omitting head markers, system messages,
 * failed/aborted assistant messages, thinking blocks, and memory lookup calls/results.
 */
export function leafOf(entry: EntryRecord): LeafDraft | undefined {
  if (entry.head !== undefined) return undefined;
  const messages = (entry.model ?? []).filter(
    (message): message is Exclude<Message, { role: "system" }> =>
      message.role !== "system" &&
      !(message.role === "assistant" && EXCLUDED_STOP_REASONS.has(message.stopReason)),
  );
  const first = messages[0];
  if (first === undefined) return undefined;
  const text = messages.map(textOf).filter(Boolean).join("\n").trim();
  if (text === "") return undefined;
  return { entry: entry.id, kind: KINDS[first.role], text, at: first.timestamp };
}

export const sourceOf = (leaf: Pick<Leaf, "kind" | "text">): string => `${leaf.kind}: ${leaf.text}`;

export function proseOf(leaf: Pick<Leaf, "kind" | "text">): string {
  if (leaf.kind === "tool") return "";
  return leaf.text
    .split("\n")
    .filter((line) => !line.startsWith(CALL_MARK))
    .join("\n");
}

function textOf(message: Exclude<Message, { role: "system" }>): string {
  switch (message.role) {
    case "user":
      return typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    case "assistant":
      return message.content
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type !== "toolCall" || LOOKUPS.has(part.name)) return "";
          return `${CALL_MARK}${part.name} ${JSON.stringify(part.arguments)}`;
        })
        .filter(Boolean)
        .join("\n");
    case "toolResult": {
      if (LOOKUPS.has(message.toolName)) return "";
      const output = message.content
        .map((part) => (part.type === "text" ? part.text : "[image]"))
        .join("\n");
      const status = message.isError ? " (error)" : "";
      return `${message.toolName}${status}: ${clipMiddle(output, TOOL_OUTPUT_CHARS)}`;
    }
  }
}
