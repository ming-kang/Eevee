import type { Context } from "@earendil-works/chord/context";
import {
  ConversationBusy,
  type ConversationHandle,
  type ConversationId,
  defineDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type SubmissionDraft,
  type Tx,
} from "@earendil-works/pi-durable";
import { Board, TicketDoc } from "../../contracts/docs.ts";
import type { NoticeData, Report, Ticket, TicketId } from "../../contracts/index.ts";
import {
  appendReport,
  conversationOf,
  type DocReader,
  maybeConversationOf,
  readTicket,
} from "./board.ts";
import { type Delivery, fromUser, route, type Target } from "./delivery.ts";

export const NOTICE_KIND = "eevee.notice";

export const Outbox = defineDoc<{ pending: Delivery[] }>({
  kind: "eevee.outbox",
  version: 1,
  scope: "session",
  initial: () => ({ pending: [] }),
  checkpointWhen: () => true,
});

export const WorkerQueue = defineDoc<{ pending: QueuedStart[] }>({
  kind: "eevee.worker-queue",
  version: 2,
  scope: "session",
  initial: () => ({ pending: [] }),
  // Version 1 stored whole deliveries, of which only a ticket's start ever queued; anything else is dropped.
  migrate: (value) => ({
    pending: (value.pending as unknown[])
      .map((entry) => queuedStartOf(entry))
      .filter((start): start is QueuedStart => start !== undefined),
  }),
  checkpointWhen: () => true,
});

/** A ticket waiting for a free slot, to start its run with one `continue`. */
export type QueuedStart = { ticketId: TicketId; requestId: string };

/** Queues the start of a ticket's run; its `requestId` keeps the opening's, so a restart stays deduplicated. */
export async function enqueueStart(tx: Tx, ticketId: TicketId): Promise<void> {
  (await tx.doc(WorkerQueue)).pending.push({ ticketId, requestId: `opening:${ticketId}` });
}

/** A version 1 queue entry as the start it was; `undefined` for anything that was not one. */
function queuedStartOf(entry: unknown): QueuedStart | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const stored = entry as { target?: { kind?: unknown; id?: unknown }; requestId?: unknown };
  if (stored.target?.kind !== "ticket") return undefined;
  if (typeof stored.target.id !== "string" || typeof stored.requestId !== "string")
    return undefined;
  return { ticketId: stored.target.id as TicketId, requestId: stored.requestId };
}

export type PreparedDelivery = {
  first?: { handle: ConversationHandle; draft: SubmissionDraft };
  rest: Delivery[];
};

export type DeliveryContext = {
  snapshot: DocReader["snapshot"];
  conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
  commit<T>(change: (tx: Tx) => Promise<T>, context: Context): Promise<T>;
};

export async function prepare(
  host: DeliveryContext,
  deliveries: readonly Delivery[],
  context: Context,
): Promise<PreparedDelivery> {
  for (const [index, delivery] of deliveries.entries()) {
    const handle = await resolveHandle(host, delivery.target, context);
    if (handle === undefined) continue;
    return {
      first: { handle, draft: toSubmission(delivery) },
      rest: deliveries.slice(index + 1),
    };
  }
  return { rest: [] };
}

export async function submit(tx: Tx, prepared: PreparedDelivery): Promise<void> {
  if (prepared.first !== undefined) await prepared.first.handle.submit(tx, prepared.first.draft);
  if (prepared.rest.length > 0) (await tx.doc(Outbox)).pending.push(...prepared.rest);
}

/** Drops every delivery waiting for a ticket, so closing it leaves nothing queued behind. */
export async function purgeDeliveries(tx: Tx, id: TicketId): Promise<void> {
  const outbox = await tx.doc(Outbox);
  outbox.pending = outbox.pending.filter(
    (d) => !(d.target.kind === "ticket" && d.target.id === id),
  );
  const queue = await tx.doc(WorkerQueue);
  queue.pending = queue.pending.filter((s) => s.ticketId !== id);
}

export async function flush(host: DeliveryContext, context: Context): Promise<void> {
  for (;;) {
    const next = (await host.snapshot(Outbox, context))?.pending[0];
    if (next === undefined) return;
    const handle = await resolveHandle(host, next.target, context);
    const ticket = await seedTicket(host, next.target, context);
    await host.commit(async (tx) => {
      if (handle !== undefined && (await stillOpen(tx, ticket))) {
        await handle.submit(tx, toSubmission(next));
      }
      const outbox = await tx.doc(Outbox);
      outbox.pending = outbox.pending.filter((d) => d.requestId !== next.requestId);
    }, context);
  }
}

export async function deliver(
  host: DeliveryContext,
  deliveries: readonly Delivery[],
  context: Context,
  change?: (tx: Tx) => Promise<void>,
): Promise<void> {
  const prepared = await prepare(host, deliveries, context);
  await host.commit(async (tx) => {
    await submit(tx, prepared);
    await change?.(tx);
  }, context);
  await flush(host, context);
}

/** Appends a report to its ticket and hands its notice to the Router, in the caller's commit. */
export async function submitReport(
  tx: Tx,
  router: ConversationHandle,
  ticket: Ticket,
  draft: Omit<Report, "seq">,
): Promise<Report> {
  const report = await appendReport(tx, draft);
  for (const delivery of route({ type: "report", ticket, report })) {
    await router.submit(tx, toSubmission(delivery));
  }
  return report;
}

export async function queuedTickets(reader: DocReader, context: Context): Promise<Set<TicketId>> {
  const pending = (await reader.snapshot(WorkerQueue, context))?.pending ?? [];
  return new Set(pending.map((start) => start.ticketId));
}

export async function pump(host: DeliveryContext, limit: number, context: Context): Promise<void> {
  const pending = (await host.snapshot(WorkerQueue, context))?.pending ?? [];
  if (pending.length === 0) return;
  let active = await activeWorkers(host, context);
  for (const start of pending) {
    const ticket = await readTicket(host, start.ticketId, context);
    if (ticket === undefined || ticket.status !== "open") {
      await host.commit((tx) => dropStart(tx, start.requestId), context);
      continue;
    }
    const busy = (await host.snapshot(LiveDoc, conversationOf(ticket), context))?.run !== undefined;
    // A busy ticket, or a full set of slots, leaves the start queued for the next pass.
    if (busy || active >= limit) continue;
    const handle = await host.conversation(conversationOf(ticket), context);
    if (handle === undefined) {
      await host.commit((tx) => dropStart(tx, start.requestId), context);
      continue;
    }
    const started = await host.commit(async (tx) => {
      if (!(await stillOpen(tx, ticket))) return false;
      try {
        await handle.submit(tx, { type: "continue", requestId: start.requestId });
      } catch (error) {
        if (error instanceof ConversationBusy) return false;
        throw error;
      }
      await dropStart(tx, start.requestId);
      return true;
    }, context);
    if (started) active += 1;
  }
}

/** Takes a start out of the queue, whether its ticket is gone or its run has begun. */
async function dropStart(tx: Tx, requestId: string): Promise<void> {
  const queue = await tx.doc(WorkerQueue);
  queue.pending = queue.pending.filter((start) => start.requestId !== requestId);
}

export function toSubmission(delivery: Delivery): SubmissionDraft {
  if (delivery.mode === "wake") {
    return {
      type: "input",
      requestId: delivery.requestId,
      content: delivery.text,
      whenBusy: delivery.whenBusy,
      ...(fromUser(delivery) ? {} : { entry: { kind: NOTICE_KIND, data: noticeData(delivery) } }),
    };
  }
  return {
    type: "write",
    requestId: delivery.requestId,
    entry: {
      kind: NOTICE_KIND,
      data: noticeData(delivery),
      model: [{ role: "user", content: delivery.text, timestamp: Date.now() }],
    },
  };
}

const noticeData = (delivery: Delivery): NoticeData => ({
  requestId: delivery.requestId,
  ...(delivery.notice === undefined ? {} : { notice: delivery.notice }),
});

async function activeWorkers(host: DeliveryContext, context: Context): Promise<number> {
  let active = 0;
  for (const id of (await host.snapshot(Board, context))?.tickets ?? []) {
    const ticket = await readTicket(host, id, context);
    if (ticket?.status !== "open") continue;
    if ((await host.snapshot(LiveDoc, conversationOf(ticket), context))?.run !== undefined) {
      active += 1;
    }
  }
  return active;
}

async function seedTicket(
  host: DeliveryContext,
  target: Target,
  context: Context,
): Promise<Ticket | undefined> {
  return target.kind === "ticket" ? readTicket(host, target.id, context) : undefined;
}

/** Whether a ticket is still open, re-read in the committing transaction; anything without a ticket passes. */
async function stillOpen(tx: Tx, ticket: Ticket | undefined): Promise<boolean> {
  if (ticket === undefined) return true;
  return (await tx.doc(TicketDoc, ticket.id, null)).status === "open";
}

async function resolveHandle(
  host: DeliveryContext,
  target: Target,
  context: Context,
): Promise<ConversationHandle | undefined> {
  const id = await resolveTarget(host, target, context);
  return id === undefined ? undefined : host.conversation(id, context);
}

async function resolveTarget(
  host: DeliveryContext,
  target: Target,
  context: Context,
): Promise<ConversationId | undefined> {
  if (target.kind === "router") return ROOT_CONVERSATION_ID;
  return maybeConversationOf(await readTicket(host, target.id as TicketId, context));
}
