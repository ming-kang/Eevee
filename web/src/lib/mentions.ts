import type { TicketView } from "@shared/api/contract.ts";

/** An "@…" mention in flight at the caret: where the "@" sits and what was typed after it. */
export type MentionQuery = {
  start: number;
  query: string;
};

const TOKEN = /[\w-]/;
export const MENTION_LIMIT = 8;

/**
 * The mention a caret is finishing, like `@t4|`: "@" plus `[\w-]*` ending exactly at the caret,
 * where the "@" is at a line start or right after whitespace (so `a@b` in prose is not one).
 */
export function mentionQuery(text: string, caret: number): MentionQuery | undefined {
  if (caret <= 0 || caret > text.length) return undefined;
  const after = text[caret];
  if (after !== undefined && TOKEN.test(after)) return undefined;
  let i = caret;
  while (i > 0 && TOKEN.test(text[i - 1] ?? "")) i--;
  if (i === 0 || text[i - 1] !== "@") return undefined;
  const at = i - 1;
  if (at > 0 && !/\s/.test(text[at - 1] ?? "")) return undefined;
  return { start: at, query: text.slice(i, caret) };
}

/**
 * Tickets matching a mention query: id prefixes first, then title substrings (both
 * case-insensitive); open tickets before closed ones. At most {@link MENTION_LIMIT}.
 */
export function rankTickets(tickets: readonly TicketView[], query: string): TicketView[] {
  const q = query.toLowerCase();
  const scored: { view: TicketView; open: number; prefix: number }[] = [];
  for (const view of tickets) {
    const id = view.ticket.id.toLowerCase();
    const prefix = id.startsWith(q) ? 0 : 1;
    if (prefix === 1 && (q === "" || !view.ticket.title.toLowerCase().includes(q))) continue;
    scored.push({ view, open: view.ticket.status === "open" ? 0 : 1, prefix });
  }
  scored.sort((a, b) => a.prefix - b.prefix || a.open - b.open);
  return scored.slice(0, MENTION_LIMIT).map((s) => s.view);
}

/** A stretch of a user message: plain text, or a ticket reference the reader can open. */
export type TextPart = { kind: "text"; text: string } | { kind: "ticket"; ticketId: string };

/** `t\d+` tokens that name a real ticket become reference parts; everything else stays text. */
export function splitTicketRefs(text: string, ids: ReadonlySet<string>): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/\bt\d+\b/g)) {
    const ticketId = match[0];
    if (!ids.has(ticketId)) continue;
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
    parts.push({ kind: "ticket", ticketId });
    last = match.index + ticketId.length;
  }
  if (last === 0) return [{ kind: "text", text }];
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}
