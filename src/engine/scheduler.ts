import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type CommitPublication,
  type Conversation,
  type Harness,
  LiveDoc,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Board, TicketDoc } from "../contracts/docs.ts";
import type { Ticket, TicketId } from "../contracts/index.ts";
import {
  contextUsage,
  conversationOf,
  type DeliveryContext,
  deliver,
  pump,
  readTicket,
  remindRouter,
  reportRunFailures,
  route,
  routerIdle,
  WorkerQueue,
} from "../extensions/orchestration/index.ts";
import { SerialPass } from "../shared/serial-pass.ts";
import type { Settings } from "../shared/settings.ts";

const UPKEEP_MS = 5_000;

/** Commits to these documents want a pass: a start was queued, a run ended and freed a slot, a ticket settled. */
const PASS_DOC_KINDS = new Set([
  WorkerQueue.definition.kind,
  LiveDoc.definition.kind,
  TicketDoc.definition.kind,
]);

export type SchedulerDeps = {
  harness: Pick<Harness, "snapshot" | "conversation" | "commit">;
  root: Conversation;
  jobs: { stop(ticketId: TicketId): void };
  settings: () => Settings;
  models: () => Models;
  context: Context;
  label: string;
  upkeepMs?: number;
  /** Dreaming's trigger check, run at the end of every upkeep. */
  dream?: (now: number) => Promise<void>;
};

/**
 * The one background loop of a project. A commit that queues work, ends a run, or settles a ticket asks for a
 * pass through `hear()`; the timer asks for one every `upkeepMs` for the periodic upkeep. Each pass stops the
 * settled tickets it knows, then hands queued work to free worker slots, then, when upkeep is due, reports run
 * failures, reminds the Router of unanswered reports, and nudges a handoff when its context is nearly full.
 * A settled ticket whose stop fails stays queued for the next pass; `close()` waits for the pass under way, so
 * nothing it does reaches a closed Session.
 */
export class Scheduler {
  readonly #deps: SchedulerDeps;
  readonly #stopping = new Set<TicketId>();
  readonly #pass: SerialPass;
  readonly #timer: NodeJS.Timeout;
  #lastUpkeep = 0;

  private constructor(deps: SchedulerDeps) {
    this.#deps = deps;
    this.#pass = new SerialPass(
      () => this.#run(),
      (error) => console.error(`[${deps.label}] The dispatch loop hit an error.`, error),
    );
    this.#timer = setInterval(() => this.#pass.request(), deps.upkeepMs ?? UPKEEP_MS);
    this.#timer.unref();
  }

  /**
   * Queues the settled tickets an earlier process could not stop, from the board, then starts the loop with a
   * first pass.
   */
  static async start(deps: SchedulerDeps): Promise<Scheduler> {
    const scheduler = new Scheduler(deps);
    for (const id of (await deps.harness.snapshot(Board, deps.context))?.tickets ?? []) {
      const ticket = await readTicket(deps.harness, id, deps.context);
      if (ticket !== undefined && unstopped(ticket)) scheduler.#stopping.add(ticket.id);
    }
    scheduler.#pass.request();
    return scheduler;
  }

  /** Hears one stored commit: the publications a single `observeCommits` observer fans out to it. */
  hear(pub: CommitPublication): void {
    let touched = false;
    for (const change of pub.changes) {
      if (change.type !== "document") continue;
      if (change.record.kind === TicketDoc.definition.kind && change.kind === "change") {
        const ticket = change.value as unknown as Ticket;
        if (unstopped(ticket)) this.#stopping.add(ticket.id);
      }
      if (PASS_DOC_KINDS.has(change.record.kind)) touched = true;
    }
    if (touched || this.#stopping.size > 0) this.#pass.request();
  }

  /** Runs a pass: for a settings change a commit does not announce, and to retry a stop that failed. */
  request(): void {
    this.#pass.request();
  }

  /** Stops the timer and waits for the pass under way, so dependent resources can close after it. */
  async close(): Promise<void> {
    clearInterval(this.#timer);
    await this.#pass.close();
  }

  async #run(): Promise<void> {
    const { context, settings } = this.#deps;
    const host = deliveryHost(this.#deps.harness, this.#deps.root);
    await this.#reap();
    await pump(host, settings().maxActiveWorkers, context);
    const now = Date.now();
    if (now - this.#lastUpkeep < (this.#deps.upkeepMs ?? UPKEEP_MS)) return;
    this.#lastUpkeep = now;
    await reportRunFailures(host, now, context);
    await remindRouter(host, { olderThan: settings().reminderAfterMs, now }, context);
    await this.#nudgeHandoff(host, settings().handoffThreshold);
    await this.#deps.dream?.(now);
  }

  /** Stops every settled ticket's execution: its jobs, its conversation, and only then the record of it. */
  async #reap(): Promise<void> {
    const { harness, jobs, context, label } = this.#deps;
    for (const id of [...this.#stopping]) {
      if (this.#pass.closed) return;
      const ticket = await readTicket(harness, id, context);
      if (ticket === undefined || !unstopped(ticket)) {
        this.#stopping.delete(id);
        continue;
      }
      try {
        jobs.stop(id);
        const conversation = await harness.conversation(conversationOf(ticket), context);
        await conversation?.abort(context);
        await harness.commit(async (tx) => {
          (await tx.doc(TicketDoc, id, null)).stoppedAt = Date.now();
        }, context);
        this.#stopping.delete(id);
      } catch (error) {
        console.error(`[${label}] Could not stop ${id}; it will be tried again.`, error);
      }
    }
  }

  async #nudgeHandoff(host: DeliveryContext, threshold: number): Promise<void> {
    const { context, models, root } = this.#deps;
    if (!(await routerIdle(host, context))) return;
    const fraction = await contextFraction(root, models(), context);
    if (fraction <= threshold) return;
    const { epoch } = await contextUsage(root, context);
    await deliver(host, route({ type: "handoff-nudge", epoch }), context);
  }
}

const unstopped = (ticket: Ticket): boolean =>
  ticket.status !== "open" && ticket.stoppedAt === undefined;

/** The share of the conversation's model context window the entries already use. */
export async function contextFraction(
  conversation: Conversation,
  models: Models,
  context: Context,
): Promise<number> {
  const model = (await conversation.agent(context)).model;
  const window = model && models.getModel(model.provider, model.modelId)?.contextWindow;
  if (!window) return 0;
  return (await contextUsage(conversation, context)).tokens / window;
}

/** The deliveries of one project: reads on the Session, writes on the Router's root conversation. */
export function deliveryHost(
  harness: Pick<Harness, "snapshot" | "conversation">,
  root: Conversation,
): DeliveryContext {
  return {
    snapshot: harness.snapshot.bind(harness) as ToolExecutionApi["snapshot"],
    conversation: (id, ctx) => harness.conversation(id, ctx),
    commit: (change, ctx) => root.commit(change, ctx),
  };
}
