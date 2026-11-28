import type {
  BoardViewPayload,
  TicketRecordPayload,
  WorkerBoardItemPayload,
} from "@eevee/protocol";
export type MentionScope = "all" | "files" | "workers" | "tickets";

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
