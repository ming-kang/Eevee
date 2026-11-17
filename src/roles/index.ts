import type { Context } from "@earendil-works/chord/context";
import {
  type AgentChange,
  type ConversationId,
  defineExtension,
  defineTool,
  type RegistrySnapshot,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { Board, TicketDoc } from "../contracts/docs.ts";
import type { ModelChoice, RoleName, Ticket, TicketId } from "../contracts/index.ts";
import type { DocReader } from "../extensions/orchestration/board.ts";
import type { TicketConversations } from "../extensions/orchestration/index.ts";
import { dreamerRole } from "./dreamer.ts";
import { applyRole, type MemorySnapshot, resolveTools } from "./role.ts";
import { HANDOFF_TOOL, type RouterSubject, routerRole } from "./router.ts";
import { workerRole } from "./worker.ts";

export type { MemorySnapshot } from "./role.ts";
export { dreamerRole, routerRole, workerRole };

export type RolesDeps = {
  project: { title: string; workspace: string };
  memory(): Promise<MemorySnapshot>;
  defaultModel(role: RoleName): ModelChoice | undefined;
  recent(conversationId: ConversationId, context: Context): Promise<string>;
};

export class NoModelConfigured extends Error {
  override name = "NoModelConfigured";
  constructor(role: RoleName) {
    super(
      `${role} 没有可用的模型：在 settings.json 的 models 里设置 default 或 ${role}，或建单时指定 provider 与 modelId。`,
    );
  }
}

export function createRoles(deps: RolesDeps) {
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
      const role = ticket.role === "dreamer" ? dreamerRole : workerRole;
      const model = ticket.model ?? deps.defaultModel(ticket.role);
      if (model === undefined) throw new NoModelConfigured(ticket.role);
      await applyRole(tx, conversationId, role, registry, {
        model,
        cwd: deps.project.workspace,
      });
    },
    async opening(ticket, latest) {
      const memory = await deps.memory();
      if (ticket.role === "dreamer") {
        return dreamerRole.opening({ ticket, since: [] }, memory);
      }
      return workerRole.opening(latest === undefined ? { ticket } : { ticket, latest }, memory);
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
        recent: await deps.recent(api.conversationId, context),
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
    extension: defineExtension({ name: "eevee.roles", tools: [handoff] }),
    routerAgent(registry: RegistrySnapshot): AgentChange {
      const model = deps.defaultModel("router");
      return {
        tools: resolveTools(registry, routerRole.tools),
        instructions: routerRole.instructions,
        cwd: deps.project.workspace,
        ...(model === undefined ? {} : { model }),
      };
    },
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
