import type { Context } from "@earendil-works/chord/context";
import type { CommitObservation, CommitPublication, Harness } from "@earendil-works/pi-durable";
import { Board, TicketDoc } from "../contracts/docs.ts";
import type { Ticket, TicketId } from "../contracts/index.ts";
import { conversationOf, readTicket } from "../extensions/orchestration/index.ts";
import { SerialPass } from "../shared/serial-pass.ts";

export type ReaperDeps = {
  harness: Pick<Harness, "snapshot" | "conversation" | "commit" | "observeCommits">;
  jobs: { stop(ticketId: TicketId): void };
  context: Context;
  /** Names the project in log lines. */
  label: string;
};

/**
 * The one place that stops a settled ticket's execution: its background jobs, its conversation, and only then the
 * record that it was stopped. It hears settled tickets from the commits that settle them and, on `start()`, from
 * the board, for the ones an earlier process could not stop; a ticket whose stop fails waits for the next pass.
 * `close()` waits for the pass under way, so nothing it does reaches a closed Session.
 */
export class Reaper {
  readonly #deps: ReaperDeps;
  readonly #stopping = new Set<TicketId>();
  readonly #pass: SerialPass;
  #observation: CommitObservation | undefined;

  constructor(deps: ReaperDeps) {
    this.#deps = deps;
    this.#pass = new SerialPass(
      () => this.#reap(),
      (error) => console.error(`[${deps.label}] Stopping settled tickets failed.`, error),
    );
  }

  async start(): Promise<void> {
    const { harness, context } = this.#deps;
    this.#observation = harness.observeCommits({
      advance: (pub) => this.#hear(pub),
      end: () => {},
    });
    for (const id of (await harness.snapshot(Board, context))?.tickets ?? []) {
      const ticket = await readTicket(harness, id, context);
      if (ticket !== undefined && unstopped(ticket)) this.#stopping.add(ticket.id);
    }
    this.#pass.request();
  }

  /** Runs a pass, which retries the tickets whose stop failed. */
  request(): void {
    this.#pass.request();
  }

  async close(): Promise<void> {
    this.#observation?.detach();
    await this.#pass.close();
  }

  #hear(pub: CommitPublication): void {
    for (const change of pub.changes) {
      if (change.type !== "document" || change.kind !== "change") continue;
      if (change.record.kind !== TicketDoc.definition.kind) continue;
      const ticket = change.value as unknown as Ticket;
      if (unstopped(ticket)) this.#stopping.add(ticket.id);
    }
    if (this.#stopping.size > 0) this.#pass.request();
  }

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
}

/** A settled ticket whose execution has not been stopped yet. */
const unstopped = (ticket: Ticket): boolean =>
  ticket.status !== "open" && ticket.stoppedAt === undefined;
