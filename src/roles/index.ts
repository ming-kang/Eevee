import type { Context } from "@earendil-works/chord/context";
import {
  type AgentChange,
  type ConversationId,
  configure,
  defineExtension,
  defineTool,
  type RegistrySnapshot,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { Board, TicketDoc } from "../contracts/docs.ts";
import {
  type ModelChoice,
  ProblemError,
  type RoleName,
  type Ticket,
  type TicketId,
} from "../contracts/index.ts";
import type { DocReader, TicketConversations } from "../extensions/orchestration/index.ts";
import { dreamerRole } from "./dreamer.ts";
import { type MemorySnapshot, type Role, resolveCapability, roleChange } from "./role.ts";
import { HANDOFF_TOOL, ROUTER_EXTENSION, type RouterSubject, routerRole } from "./router.ts";
import { workerRole } from "./worker.ts";

export type { MemorySnapshot } from "./role.ts";
export { resolveCapability } from "./role.ts";
export { dreamerRole, ROUTER_EXTENSION, routerRole, workerRole };

/** Rounds of the Router's own conversation a handoff carries over verbatim. */
const ROUTER_RECENT_ROUNDS = 3;
/** Rounds a ticket conversation carries over when its report asked for a fresh context. */
const TICKET_RECENT_ROUNDS = 2;

const ROLES: Record<RoleName, Role<never>> = {
  router: routerRole,
  worker: workerRole,
  dreamer: dreamerRole,
};

/** Each role's own extensions, by name, for showing next to the ones the user added. */
export const roleExtensions = (role: RoleName): readonly string[] => ROLES[role].extensions;

export type RolesDeps = {
  project: { title: string; workspace: string };
  memory(): Promise<MemorySnapshot>;
  defaultModel(role: RoleName): ModelChoice | undefined;
  /** Extensions the user enabled for a role on top of its own, by name. */
  enabled(role: RoleName): readonly string[];
  maxTurns(role: RoleName): number | undefined;
  /** The last rounds of a conversation as text, for the opening that continues it after a reset. */
  recent(conversationId: ConversationId, rounds: number, context: Context): Promise<string>;
  /** Told about enabled extensions nothing installed answers to; the role is applied without them. */
  onMissing?(role: RoleName, missing: string[]): void;
};

export function createRoles(deps: RolesDeps) {
  /** The agent change applying `role`: its extensions and the enabled ones, its prompt, the model. */
  const agent = (role: RoleName, registry: RegistrySnapshot, model?: ModelChoice): AgentChange => {
    const capability = resolveCapability(registry, [
      ...ROLES[role].extensions,
      ...deps.enabled(role),
    ]);
    if (capability.missing.length > 0) deps.onMissing?.(role, capability.missing);
    const chosen = model ?? deps.defaultModel(role);
    const maxTurns = deps.maxTurns(role);
    return roleChange(ROLES[role], capability, {
      cwd: deps.project.workspace,
      ...(chosen === undefined ? {} : { model: chosen }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
    });
  };

  const routerSubject = async (
    reader: DocReader,
    context: Context,
    extra: Pick<RouterSubject, "summary" | "recent"> = {},
  ): Promise<RouterSubject> => ({
    project: deps.project,
    tickets: await ticketOverview(reader, context),
    ...extra,
  });

  const ticketConversations: TicketConversations = {
    async configure(tx, conversationId, ticket, registry) {
      const change = agent(ticket.role, registry, ticket.model);
      if (change.model === undefined)
        throw new ProblemError({ code: "model_unset", role: ticket.role });
      await configure(tx, conversationId, change);
    },
    async opening(ticket, context, handoff) {
      const memory = await deps.memory();
      if (ticket.role === "dreamer") return dreamerRole.opening({ ticket }, memory);
      if (handoff === undefined) return workerRole.opening({ ticket }, memory);
      const recent = await deps.recent(handoff.conversationId, TICKET_RECENT_ROUNDS, context);
      return workerRole.opening({ ticket, latest: handoff.latest, recent }, memory);
    },
  };

  const handoff = defineTool({
    name: HANDOFF_TOOL,
    description:
      "交接：写下一段交接小结，然后从“记忆 + 工单一览 + 小结 + 最近几轮原文”重新开始。" +
      "有长期价值的决策先用 memory 记下。",
    parameters: obj({
      summary: str({ description: "交接小结：正在做什么、做了哪些决定、接下来要做什么" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const subject = await routerSubject(api, context, {
        summary: args.summary,
        recent: await deps.recent(api.conversationId, ROUTER_RECENT_ROUNDS, context),
      });
      const opening = routerRole.opening(subject, await deps.memory());
      return {
        output: [{ type: "text", text: "已交接，从新的上下文继续。" }],
        control: { handoff: opening, terminate: true },
      };
    },
  });

  return {
    ticketConversations,
    extension: defineExtension({ name: ROUTER_EXTENSION, tools: [handoff] }),
    agent,
    async routerOpening(reader: DocReader, context: Context): Promise<string> {
      return routerRole.opening(await routerSubject(reader, context), await deps.memory());
    },
  };
}

export type Roles = ReturnType<typeof createRoles>;

async function ticketOverview(reader: DocReader, context: Context): Promise<string[]> {
  const ids = (await reader.snapshot(Board, context))?.tickets ?? [];
  const tickets: Ticket[] = [];
  for (const id of ids as TicketId[]) {
    const ticket = await reader.snapshot(TicketDoc, id, context);
    if (ticket?.status === "open") tickets.push(ticket);
  }
  return tickets.map((t) => `${t.id}「${t.title}」 ticket://${t.id}`);
}
