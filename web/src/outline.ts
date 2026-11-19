import type { TranscriptDisplayItem } from "./transcript-map.ts";

/** One row in the conversation outline: the user (or answered-question) message it jumps to. */
export type OutlineEntry = {
  key: string;
  /** First line of the message, cut around 80 characters for the hover list. */
  text: string;
  /** The answer it got: the start of the turn's last reply, collapsed to one breath. */
  reply?: string;
  at?: number;
};

const MAX_TEXT = 80;
const MAX_REPLY = 120;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The last reply a folded turn wrote — it hides inside the group. */
const workedReply = (item: TranscriptDisplayItem): string | undefined =>
  item.kind === "worked"
    ? item.items.findLast((child) => child.kind === "assistant")?.text
    : undefined;

/** The outline follows the reader's own words: one entry per `user` and `qa` line. */
export function outlineEntries(items: readonly TranscriptDisplayItem[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let current: OutlineEntry | undefined;
  for (const item of items) {
    if (item.kind === "user" || item.kind === "qa") {
      const source = item.kind === "user" ? item.text : item.answer;
      const first = source.trim().split("\n", 1)[0]?.trim() ?? "";
      const text = first.length > MAX_TEXT ? `${first.slice(0, MAX_TEXT - 1)}…` : first;
      const entry: OutlineEntry = { key: item.key, text };
      if (item.at !== undefined) entry.at = item.at;
      out.push(entry);
      current = entry;
      continue;
    }
    const reply = item.kind === "assistant" ? item.text : workedReply(item);
    if (reply !== undefined && current !== undefined) {
      const cut = collapse(reply);
      if (cut !== "") {
        current.reply = cut.length > MAX_REPLY ? `${cut.slice(0, MAX_REPLY - 1)}…` : cut;
      }
    }
  }
  return out;
}

/** Index of the entry at or above the viewport line, −1 while the reader is above the first. */
export function activeEntry(tops: readonly number[], scrollTop: number, offset: number): number {
  let active = -1;
  const line = scrollTop + offset;
  for (const [i, top] of tops.entries()) {
    if (top <= line) active = i;
    else break;
  }
  return active;
}
