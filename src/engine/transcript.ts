import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type Conversation,
  type EntryId,
  type EntryRecord,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import type { ChatLine } from "../api/contract.ts";
import { NOTICE_KIND } from "../extensions/orchestration/index.ts";

export async function recentLines(
  conversation: Conversation,
  limit: number,
  context: Context,
): Promise<ChatLine[]> {
  const page = await conversation.entries({ order: "descending" }, limit, undefined, context);
  return page.items.flatMap(toLine).reverse();
}

export function toLine(entry: EntryRecord): ChatLine[] {
  const line = (role: ChatLine["role"], text: string): ChatLine[] =>
    text === "" ? [] : [{ id: entry.id, role, text }];
  if (UserEntry.is(entry)) return line("user", textOf(entry.model));
  if (AssistantEntry.is(entry)) return line("assistant", textOf(entry.model));
  if (ToolResultEntry.is(entry)) return line("tool", textOf(entry.model));
  if (ResetEntry.is(entry)) return line("reset", textOf(entry.model) || "（上下文已重置）");
  if (entry.kind === NOTICE_KIND) return line("notice", textOf(entry.model));
  return [];
}

export function summarizeLine(line: ChatLine, max = 200): string {
  const text = line.text.replaceAll("\n", " ");
  const short = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return `#${line.id} ${line.role}: ${short}`;
}

function textOf(messages: EntryRecord["model"]): string {
  return (messages ?? [])
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [];
      return content.flatMap((part: { type?: string; text?: string; name?: string }) => {
        if (part.type === "text" && part.text) return [part.text];
        if (part.type === "toolCall" && part.name) return [`[调用 ${part.name}]`];
        return [];
      });
    })
    .join("\n")
    .trim();
}

export async function entryText(
  conversation: Conversation,
  entryId: number,
  context: Context,
): Promise<string | undefined> {
  const id = entryId as EntryId;
  const page = await conversation.entries(
    { minEntryId: id, maxEntryId: id },
    1,
    undefined,
    context,
  );
  const entry = page.items[0];
  return entry === undefined ? undefined : (toLine(entry)[0]?.text ?? "");
}

const SPEAKER: Record<ChatLine["role"], string> = {
  user: "用户",
  assistant: "你",
  tool: "工具结果",
  notice: "通知",
  reset: "交接",
};

export async function recentRounds(
  conversation: Conversation,
  rounds: number,
  context: Context,
  maxToolChars = 1500,
): Promise<string> {
  const view = await conversation.context(context);
  const lines = view.entries.flatMap(toLine).filter((line) => line.role !== "reset");
  let start = lines.length;
  let seen = 0;
  while (start > 0 && seen < rounds) {
    start -= 1;
    const role = lines[start]?.role;
    if (role === "user" || role === "notice") seen += 1;
  }
  return lines
    .slice(start)
    .map((line) => {
      const text =
        line.role === "tool" ? trim(line.text, maxToolChars, conversation.id, line.id) : line.text;
      return `${SPEAKER[line.role]}：${text}`;
    })
    .join("\n\n");
}

function trim(text: string, max: number, conversationId: number, entryId: number): string {
  if (text.length <= max) return text;
  const keep = Math.floor(max / 2);
  const omitted = text.length - keep * 2;
  return `${text.slice(0, keep)}\n…[省略 ${omitted} 字，完整内容见 transcript://${conversationId}/${entryId}]…\n${text.slice(-keep)}`;
}
