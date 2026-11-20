import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import type { ChatLine } from "../protocol/contract.ts";
import type { TranscriptPage, TranscriptSource } from "./extensions/resources/index.ts";
import { NOTICE_KIND } from "./orchestration/index.ts";

type OpenConversation = (id: ConversationId, context: Context) => Promise<Conversation | undefined>;

/** `read transcript://` over the session's conversations. */
export function transcriptSource(open: OpenConversation): TranscriptSource {
  return {
    async entry(conversationId, entryId, context) {
      const conversation = await open(conversationId as ConversationId, context);
      return conversation && entryText(conversation, entryId, context);
    },
    async page(conversationId, range, context) {
      const conversation = await open(conversationId as ConversationId, context);
      return conversation && transcriptPage(conversation, range, context);
    },
  };
}

export async function recentLines(
  conversation: Conversation,
  limit: number,
  context: Context,
): Promise<ChatLine[]> {
  return (await transcriptPage(conversation, { limit }, context)).lines;
}

/** Lines of `limit` entries from entry `from` on, or of the newest `limit` entries without it. */
export async function transcriptPage(
  conversation: Conversation,
  range: { from?: number; limit: number },
  context: Context,
): Promise<TranscriptPage & { lines: ChatLine[] }> {
  if (range.from === undefined) {
    const page = await conversation.entries(
      { order: "descending" },
      range.limit,
      undefined,
      context,
    );
    const lines = page.items.flatMap(toLine).reverse();
    return page.next === undefined ? { lines } : { lines, earlier: true };
  }
  const query = { minEntryId: range.from as EntryId };
  const page = await conversation.entries(query, range.limit, undefined, context);
  const lines = page.items.flatMap(toLine);
  const last = page.items.at(-1)?.id;
  return page.next === undefined || last === undefined ? { lines } : { lines, next: last + 1 };
}

export function toLine(entry: EntryRecord): ChatLine[] {
  const line = (role: ChatLine["role"], text: string): ChatLine[] =>
    text === "" ? [] : [{ id: entry.id, role, text }];
  if (UserEntry.is(entry)) return line("user", textOf(entry.model));
  if (AssistantEntry.is(entry)) return line("assistant", textOf(entry.model));
  if (ToolResultEntry.is(entry)) return line("tool", textOf(entry.model));
  if (ResetEntry.is(entry)) return line("reset", textOf(entry.model) || "(context reset)");
  if (entry.kind === NOTICE_KIND) return line("notice", textOf(entry.model));
  return [];
}

function textOf(messages: EntryRecord["model"]): string {
  return (messages ?? [])
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [];
      return content.flatMap((part: { type?: string; text?: string; name?: string }) => {
        if (part.type === "text" && part.text) return [part.text];
        if (part.type === "toolCall" && part.name) return [`[call ${part.name}]`];
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
  user: "user",
  assistant: "you",
  tool: "tool result",
  notice: "notice",
  reset: "handoff",
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
      return `${SPEAKER[line.role]}: ${text}`;
    })
    .join("\n\n");
}

function trim(text: string, max: number, conversationId: number, entryId: number): string {
  if (text.length <= max) return text;
  const keep = Math.floor(max / 2);
  const omitted = text.length - keep * 2;
  return `${text.slice(0, keep)}\n…[omitted ${omitted} characters; full content at transcript://${conversationId}/${entryId}]…\n${text.slice(-keep)}`;
}
