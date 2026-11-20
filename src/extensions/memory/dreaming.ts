import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type DocumentReader,
  defineDoc,
  defineTask,
  type EntryRecord,
  ROOT_CONVERSATION_ID,
  type Tx,
  UserEntry,
} from "@earendil-works/pi-durable";
import { Board, ReportLog, TicketDoc } from "../../contracts/docs.ts";
import { formatAddress, type Ticket, type TicketId } from "../../contracts/index.ts";

/** Dreaming's trigger policy; the settings' resolved `dreaming` object carries it. */
export type DreamPolicy = {
  idleMs: number;
  minGapMs: number;
  afterTickets: number;
  afterLessons: number;
};

export type DreamingPort = {
  /** The current policy; `undefined` while Dreaming is off or the dreamer has no model. */
  policy(): DreamPolicy | undefined;
  /** When the project went idle; `undefined` while the Router, a Worker or a job runs. */
  idleSince(context: Context): Promise<number | undefined>;
  /** A conversation's entries, for listing the records a dreaming has not seen. */
  contextOf(id: ConversationId, context: Context): Promise<{ entries: readonly EntryRecord[] }>;
  open(tx: Tx, draft: DreamDraft, now: number, context: Context): Promise<TicketId>;
};

export type DreamDraft = {
  title: string;
  goal: string;
  inputs: string[];
  acceptance: string[];
};

export type DreamLogState = {
  lastAt: number | null;
  ticket: TicketId | null;
  /** Conversation → newest entry already handed to a dreaming ticket. */
  seen: Record<string, number>;
};

function emptyLog(): DreamLogState {
  return { lastAt: null, ticket: null, seen: {} };
}

export const DreamLog = defineDoc<DreamLogState>({
  kind: "eevee.dream-log",
  version: 1,
  scope: "session",
  initial: emptyLog,
  checkpointWhen: () => true,
});

const NOTE_LIMIT = 80;

type Reader = Pick<DocumentReader, "snapshot">;
type DreamHost = Reader & Pick<Conversation, "commit">;

/**
 * The one place a dreamer ticket comes from, called by the Scheduler whenever it runs upkeep. It opens one once
 * enough new material piled up since the last dreaming — closed tickets or lessons in their reports — and the
 * project has been idle for a while; two dreamings keep `minGapMs` between them and at most one is open.
 */
export async function dreamIfDue(
  host: DreamHost,
  port: DreamingPort,
  now: number,
  context: Context,
): Promise<TicketId | undefined> {
  const policy = port.policy();
  if (policy === undefined) return undefined;
  const log = (await host.snapshot(DreamLog, context)) ?? emptyLog();
  if (log.ticket !== null && (await dreaming(host, log.ticket, context))) return undefined;
  if (log.lastAt !== null && now - log.lastAt < policy.minGapMs) return undefined;
  const idleSince = await port.idleSince(context);
  if (idleSince === undefined || now - idleSince < policy.idleMs) return undefined;

  const tickets = await nonDreamerTickets(host, context);
  const since = log.lastAt ?? 0;
  const closed = tickets.filter(
    (ticket) => ticket.status !== "open" && (ticket.closedAt ?? 0) > since,
  );
  const lessons = await lessonsSince(host, tickets, since, context);
  if (closed.length < policy.afterTickets && lessons < policy.afterLessons) return undefined;

  const records = await newRecords(host, log, (id) => port.contextOf(id, context), context);
  if (records.inputs.length === 0) return undefined;
  return host.commit(async (tx) => {
    const id = await port.open(tx, draft(records.inputs), now, context);
    const doc = await tx.doc(DreamLog);
    doc.lastAt = now;
    doc.ticket = id;
    doc.seen = records.seen;
    return id;
  }, context);
}

async function dreaming(reader: Reader, ticket: TicketId, context: Context): Promise<boolean> {
  return (await reader.snapshot(TicketDoc, ticket, context))?.status === "open";
}

/** Every ticket but the dreamer's own; dreaming never tidies itself into more dreaming. */
async function nonDreamerTickets(reader: Reader, context: Context): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
  for (const id of (await reader.snapshot(Board, context))?.tickets ?? []) {
    const ticket = await reader.snapshot(TicketDoc, id, context);
    if (ticket !== undefined && ticket.role !== "dreamer") tickets.push(ticket);
  }
  return tickets;
}

async function lessonsSince(
  reader: Reader,
  tickets: readonly Ticket[],
  since: number,
  context: Context,
): Promise<number> {
  let count = 0;
  for (const ticket of tickets) {
    const reports = (await reader.snapshot(ReportLog, ticket.id, context))?.reports ?? [];
    count += reports.filter((r) => r.at > since).reduce((n, r) => n + (r.lessons?.length ?? 0), 0);
  }
  return count;
}

type ContextOf = (id: ConversationId) => Promise<{ entries: readonly EntryRecord[] }>;

/** Someone said something: notices, tool results and resets alone are no new record. */
const spoken = (entry: EntryRecord) => UserEntry.is(entry) || AssistantEntry.is(entry);

async function newRecords(
  reader: Reader,
  log: DreamLogState,
  contextOf: ContextOf,
  context: Context,
): Promise<{ inputs: string[]; seen: Record<string, number> }> {
  const tickets = await nonDreamerTickets(reader, context);
  const conversations: { id: ConversationId; label: string }[] = [
    { id: ROOT_CONVERSATION_ID, label: "Router" },
    ...tickets
      .filter((t) => t.status === "open" || (t.closedAt ?? 0) > (log.lastAt ?? 0))
      .map((t) => ({ id: t.conversationId as ConversationId, label: `${t.id}“${t.title}”` })),
  ];

  const inputs: string[] = [];
  const seen = { ...log.seen };
  for (const { id, label } of conversations) {
    const from = (log.seen[id] ?? -1) + 1;
    const fresh = (await contextOf(id)).entries.filter((e) => e.id >= from && spoken(e));
    const newest = fresh.at(-1)?.id;
    if (newest === undefined) continue;
    seen[id] = newest;
    const address = formatAddress({ kind: "transcript", conversationId: id });
    inputs.push(`${address} (${label}, read from offset ${from})`);
  }
  for (const ticket of tickets) {
    if (ticket.closedAt === undefined || ticket.closedAt <= (log.lastAt ?? 0)) continue;
    const note = ticket.closeNote ?? "";
    const short = note.length > NOTE_LIMIT ? `${note.slice(0, NOTE_LIMIT - 1)}…` : note;
    inputs.push(
      `${formatAddress({ kind: "report", ticketId: ticket.id })} (${ticket.title}, ${ticket.status}: ${short})`,
    );
  }
  return { inputs, seen };
}

function draft(inputs: string[]): DreamDraft {
  return {
    title: "Tidy up the memory store",
    goal: "Review the new records and reports listed in the inputs, especially the lessons and the actual execution results. Keep the project's memory store in order.",
    inputs,
    acceptance: [
      "Overlapping notes are merged. Temporary details and stale entries are removed.",
      "Old notes that execution results override are corrected in place, with the source noted.",
      "The MEMORY.md index matches the topic files and stays within 200 lines.",
    ],
  };
}

/**
 * Only retires the stored timers of versions that kept a `eevee.dream-timer` task per project: the trigger now
 * lives in the Scheduler, so any still live ends at once.
 */
export const RETIRE_DREAM_TIMER = defineTask<null, { phase: "check" }, null>({
  name: "eevee.dream-timer",
  version: 1,
  initial: () => ({ phase: "check" }),
  phases: {
    check: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
