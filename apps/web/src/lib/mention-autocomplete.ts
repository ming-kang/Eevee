import type {
  BoardViewPayload,
  TicketRecordPayload,
  WorkerBoardItemPayload,
} from "@eevee/protocol";
import { findCodeRanges, overlapsCodeRange } from "./skill-autocomplete.ts";

export type MentionScope = "all" | "files" | "workers" | "tickets";

export type MentionAutocompleteToken = {
  readonly rawQuery: string;
  readonly query: string;
  readonly scope: MentionScope;
  readonly start: number;
  readonly end: number;
};

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const EMAIL_OR_IDENT_LEFT_RE = /[\p{L}\p{N}_.+-]/u;
const WHITESPACE_RE = /\s/;

function isValidMentionLeftBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  if (prev === undefined) return true;
  if (CJK_RE.test(prev)) return true;
  return !EMAIL_OR_IDENT_LEFT_RE.test(prev);
}

function parseScope(raw: string): { readonly scope: MentionScope; readonly query: string } {
  const lower = raw.toLowerCase();
  if (lower.startsWith("files:")) return { scope: "files", query: raw.slice(6) };
  if (lower.startsWith("file:")) return { scope: "files", query: raw.slice(5) };
  if (lower.startsWith("workers:")) return { scope: "workers", query: raw.slice(8) };
  if (lower.startsWith("worker:")) return { scope: "workers", query: raw.slice(7) };
  if (lower.startsWith("tickets:")) return { scope: "tickets", query: raw.slice(8) };
  if (lower.startsWith("ticket:")) return { scope: "tickets", query: raw.slice(7) };
  return { scope: "all", query: raw };
}

export function extractMentionToken(
  text: string,
  cursorOffset: number,
): MentionAutocompleteToken | undefined {
  const cursor = Math.max(0, Math.min(cursorOffset, text.length));
  const before = text.slice(0, cursor);
  const atIndex = before.lastIndexOf("@");
  if (atIndex < 0 || !isValidMentionLeftBoundary(text, atIndex)) return undefined;

  const afterAt = text.slice(atIndex + 1, cursor);
  const quoted = afterAt.startsWith('"');
  if (quoted) {
    if (afterAt.indexOf('"', 1) !== -1 || afterAt.includes("\n")) return undefined;
  } else {
    if (WHITESPACE_RE.test(afterAt) || afterAt.includes("@")) return undefined;
  }

  let end = cursor;
  if (quoted) {
    while (end < text.length && text[end] !== '"' && text[end] !== "\n") end += 1;
    if (text[end] === '"') end += 1;
  } else {
    while (end < text.length && !WHITESPACE_RE.test(text[end] ?? "")) end += 1;
  }

  const codeRanges = findCodeRanges(text);
  if (overlapsCodeRange(atIndex, Math.max(end, atIndex + 1), codeRanges)) return undefined;

  const rawQuery = quoted ? afterAt.slice(1) : afterAt;
  const { scope, query } = parseScope(rawQuery);
  return { rawQuery, query, scope, start: atIndex, end };
}

export function applyMentionAutocomplete(
  text: string,
  token: MentionAutocompleteToken,
  value: string,
): { readonly nextText: string; readonly nextCursor: number } {
  const formatted = /\s/.test(value) ? `@"${value}"` : `@${value}`;
  const hasTrailingSpace = text[token.end] === " ";
  const insertion = hasTrailingSpace ? formatted : `${formatted} `;
  const nextText = `${text.slice(0, token.start)}${insertion}${text.slice(token.end)}`;
  const nextCursor = token.start + formatted.length + 1;
  return { nextText, nextCursor };
}

export function filterBoardMentions(
  board: BoardViewPayload | undefined,
  query: string,
  scope: MentionScope,
): {
  readonly workers: readonly WorkerBoardItemPayload[];
  readonly tickets: readonly TicketRecordPayload[];
} {
  if (!board) return { workers: [], tickets: [] };
  const needle = query.trim().toLowerCase();

  const workers =
    scope === "files" || scope === "tickets"
      ? []
      : board.workers
          .filter((w) => {
            if (needle === "") return w.status !== "closed";
            return `${w.id} ${w.name}`.toLowerCase().includes(needle);
          })
          .sort((a, b) => {
            const aClosed = a.status === "closed" ? 1 : 0;
            const bClosed = b.status === "closed" ? 1 : 0;
            return aClosed - bClosed;
          })
          .slice(0, 6);

  const tickets =
    scope === "files" || scope === "workers"
      ? []
      : board.tickets
          .filter((item) => {
            if (needle === "") return item.status === "open";
            return `${item.id} ${item.title}`.toLowerCase().includes(needle);
          })
          .sort((a, b) => {
            const aOpen = a.status === "open" ? 0 : 1;
            const bOpen = b.status === "open" ? 0 : 1;
            return aOpen - bOpen;
          })
          .slice(0, 6);

  return { workers, tickets };
}
