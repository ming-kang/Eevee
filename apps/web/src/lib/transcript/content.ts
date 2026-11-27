import { isRecord } from "../object.ts";

export type ExtractedToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (isRecord(block) && block.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

export function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts.join("\n\n");
}

export function extractToolCalls(content: unknown): ExtractedToolCall[] {
  if (!Array.isArray(content)) return [];
  const calls: ExtractedToolCall[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      calls.push({
        id: block.id,
        name: block.name,
        arguments: isRecord(block.arguments) ? block.arguments : {},
      });
    }
  }
  return calls;
}

const DETAIL_KEYS = [
  "path",
  "file_path",
  "command",
  "query",
  "pattern",
  "name",
  "title",
  "prompt",
  "message",
  "workerId",
  "ticketId",
  "taskId",
];

export function formatToolLabel(name: string, args: Record<string, unknown>): string {
  if (name === "read" && typeof args.path === "string") {
    const offset = typeof args.offset === "number" ? `:${args.offset}` : "";
    return `${args.path}${offset}`;
  }
  if (name === "bash" && typeof args.command === "string") return args.command;
  if ((name === "edit" || name === "write") && typeof args.path === "string") return args.path;
  for (const key of DETAIL_KEYS) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) {
      const flat = val.replace(/\s+/g, " ").trim();
      return flat.length > 72 ? `${flat.slice(0, 71)}…` : flat;
    }
  }
  return name;
}
