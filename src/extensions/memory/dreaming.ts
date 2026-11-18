import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type DocumentReader,
  defineDoc,
  defineTask,
  type EntryRecord,
  type RegistrySnapshot,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type Tx,
  UserEntry,
} from "@earendil-works/pi-durable";
import { Board, TicketDoc } from "../../contracts/docs.ts";
import { formatAddress, type Ticket, type TicketId } from "../../contracts/index.ts";

/** What Dreaming needs from outside the memory module. */
export type DreamingPort = {
  /** Least time between two dreaming tickets, read at every check; 0 or less turns Dreaming off. */
  intervalMs(): number;
  /** Opens the dreamer ticket in `tx`. */
  open(
    tx: Tx,
    draft: DreamDraft,
    at: { now: number; registry: RegistrySnapshot },
    context: Context,
  ): Promise<TicketId>;
};

export type DreamDraft = {
  title: string;
  goal: string;
  inputs: string[];
  acceptance: string[];
};

export type DreamLogState = {
  /** The timer task. */
  timer: TaskId | null;
  /** When the last dreaming ticket was opened. */
  lastAt: number | null;
  ticket: TicketId | null;
  /** Conversation → newest entry already handed to a dreaming ticket. */
  seen: Record<string, number>;
};

function emptyLog(): DreamLogState {
  return { timer: null, lastAt: null, ticket: null, seen: {} };
}

export const DreamLog = defineDoc<DreamLogState>({
  kind: "eevee.dream-log",
  version: 1,
  scope: "session",
  initial: emptyLog,
  checkpointWhen: () => true,
});

/** How often a disabled or busy Dreaming looks again. */
const RECHECK_MS = 60 * 60 * 1000;
const NOTE_LIMIT = 80;

type Reader = Pick<DocumentReader, "snapshot">;

/**
 * A background task of the root conversation: it sleeps, and when it wakes and something happened since the
 * last time, it opens one dreamer ticket that lists where to look. Sleeps are stored, so it survives restarts.
 */
export function createDreamTimer(port: DreamingPort) {
  return defineTask<null, { phase: "check" }, null>({
    name: "eevee.dream-timer",
    version: 1,
    initial: () => ({ phase: "check" }),
    phases: {
      check: async (_task, runtime, context) => {
        const now = runtime.now();
        const interval = port.intervalMs();
        const log = (await runtime.snapshot(DreamLog, context)) ?? emptyLog();
        const sleep = (until: number) =>
          ({ status: "sleeping", until, checkpoint: { phase: "check" } }) as const;

        if (interval <= 0 || (await dreaming(runtime, log, context))) {
          return runtime.commit(() => sleep(now + RECHECK_MS), context);
        }
        // The first dreaming comes one interval after Dreaming is first on, not at once.
        if (log.lastAt === null) {
          return runtime.commit(async (tx) => {
            (await tx.doc(DreamLog)).lastAt = now;
            return sleep(now + interval);
          }, context);
        }
        const due = log.lastAt + interval;
        if (due > now) return runtime.commit(() => sleep(due), context);

        const records = await newRecords(
          runtime,
          log,
          (id) => runtime.context(id, context),
          context,
        );
        if (records.inputs.length === 0)
          return runtime.commit(() => sleep(now + interval), context);
        await runtime.commit(async (tx) => {
          const id = await port.open(
            tx,
            draft(records.inputs),
            { now, registry: runtime.registry },
            context,
          );
          const doc = await tx.doc(DreamLog);
          doc.lastAt = now;
          doc.ticket = id;
          doc.seen = records.seen;
          return sleep(now + interval);
        }, context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
}

export type DreamTimer = ReturnType<typeof createDreamTimer>;

/** Starts the timer unless one is live; call once the Harness is open. */
export async function ensureDreamTimer(
  host: Reader & {
    getTask(id: TaskId, context: Context): Promise<{ state: { status: string } } | undefined>;
  },
  root: Pick<Conversation, "commit">,
  timer: DreamTimer,
  context: Context,
): Promise<void> {
  const current = (await host.snapshot(DreamLog, context))?.timer;
  if (current) {
    const status = (await host.getTask(current, context))?.state.status;
    if (status !== undefined && status !== "terminal" && status !== "completing") return;
  }
  await root.commit(async (tx) => {
    const id = await tx.createTask(timer, null, {
      ownership: { kind: "conversation" },
      background: true,
    });
    (await tx.doc(DreamLog)).timer = id;
  }, context);
}

async function dreaming(reader: Reader, log: DreamLogState, context: Context): Promise<boolean> {
  if (log.ticket === null) return false;
  return (await reader.snapshot(TicketDoc, log.ticket, context))?.status === "open";
}

type ContextOf = (id: ConversationId) => Promise<{ entries: readonly EntryRecord[] }>;

/** Someone said something: notices, tool results and resets alone are no new record. */
const spoken = (entry: EntryRecord) => UserEntry.is(entry) || AssistantEntry.is(entry);

/** Conversations with entries the last dreaming did not see, and tickets closed since. */
async function newRecords(
  reader: Reader,
  log: DreamLogState,
  contextOf: ContextOf,
  context: Context,
): Promise<{ inputs: string[]; seen: Record<string, number> }> {
  const tickets: Ticket[] = [];
  for (const id of (await reader.snapshot(Board, context))?.tickets ?? []) {
    const ticket = await reader.snapshot(TicketDoc, id, context);
    if (ticket !== undefined && ticket.role !== "dreamer") tickets.push(ticket);
  }
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
