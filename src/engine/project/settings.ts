import type { Context } from "@earendil-works/chord/context";
import {
  type Conversation,
  configure,
  defineExtension,
  type Extension,
  type Harness,
  type Registry,
} from "@earendil-works/pi-durable";
import type { ModelChoice, RoleName, Ticket, TicketId } from "../../domain/index.ts";
import { Board } from "../docs.ts";
import { conversationOf, readTicket } from "../orchestration/index.ts";
import type { Roles } from "../roles/index.ts";
import type { ProjectStore } from "./store.ts";

type Deps = {
  store: ProjectStore;
  root: Conversation;
  harness: Harness;
  registry: Registry;
  roles: Roles;
  context: Context;
  shared: () => readonly Extension[];
  request: () => void;
};
export class ProjectSettings {
  readonly #deps: Deps;
  #installed: Set<string>;
  constructor(deps: Deps, installed: Set<string>) {
    this.#deps = deps;
    this.#installed = installed;
  }
  async initialize(): Promise<void> {
    await this.#applyRoles();
  }
  async setModel(role: RoleName | "default", choice: ModelChoice | null): Promise<void> {
    await this.#deps.store.update((meta) => {
      const { models: own, ...rest } = meta;
      const models = { ...own };
      if (choice === null) delete models[role];
      else models[role] = choice;
      return Object.keys(models).length === 0 ? rest : { ...rest, models };
    });
    await this.#applyRoles();
  }

  async applyModels(): Promise<void> {
    await this.#applyRoles();
    this.#deps.request();
  }

  async refreshExtensions(): Promise<void> {
    this.#installed = installShared(this.#deps.registry, this.#installed, this.#deps.shared());
    await this.#applyRoles();
    this.#deps.request();
  }

  async #applyRoles(): Promise<void> {
    const snapshot = this.#deps.registry.snapshot();
    const tickets: Ticket[] = [];
    for (const id of ((await this.#deps.harness.snapshot(Board, this.#deps.context))?.tickets ??
      []) as TicketId[]) {
      const ticket = await readTicket(this.#deps.harness, id, this.#deps.context);
      if (ticket?.status === "open") tickets.push(ticket);
    }
    await this.#deps.root.commit(async (tx) => {
      await configure(tx, this.#deps.root.id, this.#deps.roles.agent("router", snapshot));
      for (const ticket of tickets) {
        const change = this.#deps.roles.agent(ticket.role, snapshot, ticket.model);
        await configure(tx, conversationOf(ticket), change);
      }
    }, this.#deps.context);
  }
}

export function installShared(
  registry: Registry,
  installed: ReadonlySet<string>,
  next: readonly Extension[],
): Set<string> {
  const names = new Set(next.map((e) => e.name));
  for (const name of installed) {
    if (!names.has(name)) registry.uninstall(defineExtension({ name }));
  }
  for (const extension of next) registry.install(extension);
  return names;
}
