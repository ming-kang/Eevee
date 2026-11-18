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

export const WorkerQueue = defineDoc<{ pending: Delivery[] }>({
  kind: "eevee.worker-queue",
  version: 1,
  scope: "session",
  initial: () => ({ pending: [] }),
  checkpointWhen: () => true,
});

export type PreparedDelivery = {
  first?: { handle: ConversationHandle; draft: SubmissionDraft };
  rest: Delivery[];
  queued: Delivery[];
};

export type DeliveryContext = {
  snapshot: DocReader["snapshot"];
  conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
  commit<T>(change: (tx: Tx) => Promise<T>, context: Context): Promise<T>;
};

/** A delivery that waits for a free slot: only the start of an engine-run ticket does. */
export const needsSlot = (delivery: Delivery): boolean => delivery.mode === "start";

export const startOf = (delivery: Delivery): SubmissionDraft => ({
  type: "continue",
  requestId: delivery.requestId,
});

export async function prepare(
  host: DeliveryContext,
  deliveries: readonly Delivery[],
  context: Context,
): Promise<PreparedDelivery> {
  const queued = deliveries.filter(needsSlot);
  const direct = deliveries.filter((d) => !needsSlot(d));
  for (const [index, delivery] of direct.entries()) {
    const handle = await resolveHandle(host, delivery.target, context);
    if (handle === undefined) continue;
    return {
      first: { handle, draft: toSubmission(delivery) },
      rest: direct.slice(index + 1),
      queued,
    };
  }
  return { rest: [], queued };
}

export async function submit(tx: Tx, prepared: PreparedDelivery): Promise<void> {
  if (prepared.first !== undefined) await prepared.first.handle.submit(tx, prepared.first.draft);
  if (prepared.rest.length > 0) (await tx.doc(Outbox)).pending.push(...prepared.rest);
  if (prepared.queued.length > 0) (await tx.doc(WorkerQueue)).pending.push(...prepared.queued);
}

/** Drops every delivery waiting for a ticket, so closing it leaves nothing queued behind. */
export async function purgeDeliveries(tx: Tx, id: TicketId): Promise<Delivery[]> {
  const dropped: Delivery[] = [];
  for (const token of [Outbox, WorkerQueue]) {
    const queue = await tx.doc(token);
    const going = queue.pending.filter((d) => d.target.kind === "ticket" && d.target.id === id);
    if (going.length === 0) continue;
    dropped.push(...going);
    const keys = new Set(going.map((d) => d.requestId));
    queue.pending = queue.pending.filter((d) => !keys.has(d.requestId));
  }
  return dropped;
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
  return new Set(pending.flatMap((d) => (d.target.kind === "ticket" ? [d.target.id] : [])));
}

export async function pump(host: DeliveryContext, limit: number, context: Context): Promise<void> {
  const pending = (await host.snapshot(WorkerQueue, context))?.pending ?? [];
  if (pending.length === 0) return;
  let active = await activeWorkers(host, context);
  for (const delivery of pending) {
    if (delivery.target.kind !== "ticket") continue;
    const ticket = await readTicket(host, delivery.target.id, context);
    const busy =
      ticket !== undefined &&
      (await host.snapshot(LiveDoc, conversationOf(ticket), context))?.run !== undefined;
    if (ticket?.status === "open" && !busy && active >= limit) continue;
    const handle =
      ticket?.status === "open"
        ? await host.conversation(conversationOf(ticket), context)
        : undefined;
    const started = await host.commit(async (tx) => {
      if (handle === undefined) {
        const queue = await tx.doc(WorkerQueue);
        queue.pending = queue.pending.filter((d) => d.requestId !== delivery.requestId);
        return false;
      }
      if (delivery.mode === "start" && busy) return false;
      let submitted = false;
      if (await stillOpen(tx, ticket)) {
        try {
          await handle.submit(tx, toSubmission(delivery));
          submitted = true;
        } catch (error) {
          if (error instanceof ConversationBusy) return false;
          throw error;
        }
      }
      const queue = await tx.doc(WorkerQueue);
      queue.pending = queue.pending.filter((d) => d.requestId !== delivery.requestId);
      return submitted;
    }, context);
    if (started) active += 1;
  }
}

export function toSubmission(delivery: Delivery): SubmissionDraft {
  if (delivery.mode === "start") return startOf(delivery);
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
async function stillOpen(tx: Tx, seed: Ticket | undefined): Promise<boolean> {
  if (seed === undefined) return true;
  return (await tx.doc(TicketDoc, seed.id, seed)).status === "open";
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
