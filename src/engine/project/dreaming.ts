import type { Context } from "@earendil-works/chord/context";
import {
  type Conversation,
  type Harness,
  LiveDoc,
  type Registry,
} from "@earendil-works/pi-durable";
import type { Settings } from "../../config/settings.ts";
import { pickModel } from "../../domain/index.ts";
import { Board } from "../docs.ts";
import type { JobHost } from "../jobs.ts";
import { type DreamingPort, dreamIfDue } from "../memory/dreaming.ts";
import {
  conversationOf,
  openTicket,
  readTicket,
  routerIdle,
  WorkerQueue,
} from "../orchestration/index.ts";
import type { Roles } from "../roles/index.ts";
import { deliveryHost } from "../scheduler.ts";
import type { ProjectStore } from "./store.ts";

type Deps = {
  id: string;
  settings: () => Settings;
  store: ProjectStore;
  root: Conversation;
  harness: Harness;
  registry: Registry;
  roles: Roles;
  jobs: Pick<JobHost, "running">;
  context: Context;
  activeAt: () => number;
};
export class Dreaming {
  readonly #deps: Deps;
  constructor(deps: Deps) {
    this.#deps = deps;
  }
  async run(now: number): Promise<void> {
    const port: DreamingPort = {
      // Off while the dreamer has no model, so it never opens a ticket that cannot run.
      policy: () => {
        const dreaming = this.#deps.settings().dreaming;
        const model = pickModel(
          "dreamer",
          this.#deps.store.current.models,
          this.#deps.settings().models,
        );
        return dreaming.enabled && model !== undefined ? dreaming : undefined;
      },
      idleSince: (context) => this.#idleSince(context),
      contextOf: async (id, context) => {
        const found = await this.#deps.harness.conversation(id, context);
        if (found === undefined) return { entries: [] };
        return { entries: [...(await found.context(context)).entries] };
      },
      open: async (tx, draft, now, context) => {
        const ticket = await openTicket(
          tx,
          this.#deps.roles.ticketConversations,
          this.#deps.registry.snapshot(),
          { role: "dreamer", ...draft, deliverTo: [] },
          now,
          context,
        );
        return ticket.id;
      },
    };
    const opened = await dreamIfDue(
      deliveryHost(this.#deps.harness, this.#deps.root),
      port,
      now,
      this.#deps.context,
    );
    if (opened !== undefined) console.error(`[${this.#deps.id}] Dreaming opened ${opened}.`);
  }

  async #idleSince(context: Context): Promise<number | undefined> {
    const host = deliveryHost(this.#deps.harness, this.#deps.root);
    if (!(await routerIdle(host, context))) return undefined;
    if (((await host.snapshot(WorkerQueue, context))?.pending.length ?? 0) > 0) {
      return undefined;
    }
    for (const id of (await host.snapshot(Board, context))?.tickets ?? []) {
      const ticket = await readTicket(host, id, context);
      if (ticket?.status !== "open") continue;
      if ((await host.snapshot(LiveDoc, conversationOf(ticket), context))?.run !== undefined) {
        return undefined;
      }
    }
    if (this.#deps.jobs.running().length > 0) return undefined;
    return this.#deps.activeAt();
  }
}
