import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { latestFinalReport, type Ticket, type TicketId } from "../../../contracts/index.ts";
import { WorkerAnchor } from "../anchor.ts";
import {
  allocateTicketId,
  bindConversation,
  closeTicket,
  conversationOf,
  markHandled,
  readReports,
  readTicket,
  saveTicket,
} from "../board.ts";
import { deliver, submit } from "../deliver.ts";
import { route } from "../delivery.ts";
import type { OrchestrationDeps } from "../ports.ts";
import { fail, missing, ok } from "../result.ts";

export const TICKET_TOOL = "ticket";

const TICKET_ID = "^t[1-9][0-9]*$";

const Parameters = obj({
  action: oneOf(["create", "message", "interrupt", "review", "close"]),
  ticketId: opt(str({ pattern: TICKET_ID, description: "目标工单，如 t3；create 以外的动作必填" })),
  title: opt(str({ description: "create：简短标题" })),
  goal: opt(str({ description: "create：要达成什么" })),
  inputs: opt(arr(str(), { description: "create：输入文件路径或资源地址" })),
  acceptance: opt(arr(str(), { description: "create：验收标准" })),
  output: opt(str({ description: "create：产物写到哪里" })),
  deliverTo: opt(
    arr(str({ pattern: TICKET_ID }), { description: "create：验收后把结果投给这些工单" }),
  ),
  provider: opt(str({ description: "create：模型提供方，见 models://；不填用默认模型" })),
  modelId: opt(str({ description: "create：模型编号" })),
  modelReason: opt(str({ description: "create：选非默认模型时说明理由" })),
  text: opt(str({ description: "message：追加的指令" })),
  mode: opt(oneOf(["steer", "followUp"], { description: "message：引导或排队，默认排队" })),
  verdict: opt(oneOf(["accept", "rework"], { description: "review：验收通过或打回" })),
  note: opt(str({ description: "review accept 的证据 / rework 缺什么 / close 的原因" })),
});

type Args = {
  action: "create" | "message" | "interrupt" | "review" | "close";
  ticketId?: string;
  title?: string;
  goal?: string;
  inputs?: string[];
  acceptance?: string[];
  output?: string;
  deliverTo?: string[];
  provider?: string;
  modelId?: string;
  modelReason?: string;
  text?: string;
  mode?: "steer" | "followUp";
  verdict?: "accept" | "rework";
  note?: string;
};

export function createTicketTool(deps: OrchestrationDeps) {
  return defineTool({
    name: TICKET_TOOL,
    description:
      "管理工单。create 建单并启动它的执行对话；message 给执行对话追加指令；interrupt 打断它当前这一轮；" +
      "review 处理 ready 报告（accept 结单，rework 打回）；close 取消工单。",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      if (args.action === "create") return create(deps, args, api, context);
      if (args.ticketId === undefined) return fail(`${args.action} 需要 ticketId。`);
      const ticket = await readTicket(api, args.ticketId as TicketId, context);
      if (ticket === undefined) return fail(`没有工单 ${args.ticketId}。`);
      if (ticket.status !== "open")
        return fail(`${ticket.id} 已经${ticket.status === "done" ? "结单" : "取消"}。`);
      switch (args.action) {
        case "message":
          return message(ticket, args, api, context);
        case "interrupt":
          return interrupt(ticket, api, context);
        case "review":
          return review(deps, ticket, args, api, context);
        case "close":
          return close(deps, ticket, args, api, context);
      }
    },
  });
}

async function create(
  deps: OrchestrationDeps,
  args: Args,
  api: ToolExecutionApi,
  context: Context,
) {
  const absent = missing(args, ["title", "goal", "acceptance"]);
  if (absent.length > 0) return fail(`create 缺少字段：${absent.join("、")}。`);
  if ((args.provider === undefined) !== (args.modelId === undefined)) {
    return fail("provider 和 modelId 要么都填，要么都不填（使用默认模型）。");
  }
  const deliverTo = (args.deliverTo ?? []) as TicketId[];
  for (const to of deliverTo) {
    const target = await readTicket(api, to, context);
    if (target?.status !== "open") return fail(`deliverTo 里的 ${to} 不存在或已结单。`);
  }

  const ticket = await api.commit(async (tx) => {
    const id = await allocateTicketId(tx);
    const anchor = await tx.createTask(WorkerAnchor, null, {
      ownership: { kind: "conversation" },
      background: true,
    });
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
    const created: Ticket = {
      id,
      role: "worker",
      title: args.title ?? "",
      goal: args.goal ?? "",
      inputs: args.inputs ?? [],
      acceptance: args.acceptance ?? [],
      ...(args.output ? { output: args.output } : {}),
      deliverTo,
      ...(args.provider && args.modelId
        ? { model: { provider: args.provider, modelId: args.modelId } }
        : {}),
      ...(args.modelReason ? { modelReason: args.modelReason } : {}),
      conversationId: child.id,
      status: "open",
      createdAt: api.now(),
    };
    await deps.conversations.configure(tx, child.id, created, api.registry);
    await saveTicket(tx, created);
    await bindConversation(tx, child.id, id);
    for (const to of deliverTo) await markHandled(tx, to);
    const opening = await deps.conversations.opening(created, undefined, context);
    await submit(tx, {
      rest: [],
      queued: route({ type: "ticket-opened", ticketId: id, opening }),
    });
    return created;
  }, context);

  return ok(`已建单 ${ticket.id}，执行对话会在有空闲槽位时开始工作。`, {
    ticketId: ticket.id,
    conversationId: ticket.conversationId,
  });
}

async function message(ticket: Ticket, args: Args, api: ToolExecutionApi, context: Context) {
  if (!args.text) return fail("message 需要 text。");
  const event = {
    type: "router-message",
    id: api.callId,
    ticketId: ticket.id,
    text: args.text,
    whenBusy: args.mode ?? "followUp",
  } as const;
  await deliver(api, route(event), context, (tx) => markHandled(tx, ticket.id));
  return ok(`已发给 ${ticket.id}。`);
}

async function interrupt(ticket: Ticket, api: ToolExecutionApi, context: Context) {
  await (await api.conversation(conversationOf(ticket), context))?.abort(context);
  await api.commit((tx) => markHandled(tx, ticket.id), context);
  return ok(`已打断 ${ticket.id} 当前这一轮，工单仍为 open。`);
}

async function review(
  deps: OrchestrationDeps,
  ticket: Ticket,
  args: Args,
  api: ToolExecutionApi,
  context: Context,
) {
  if (args.verdict === undefined || !args.note) return fail("review 需要 verdict 和 note。");
  const latest = latestFinalReport(await readReports(api, ticket.id, context));
  if (latest?.status !== "ready" || latest.handled) {
    return fail(`${ticket.id} 没有待验收的 ready 报告。`);
  }

  if (args.verdict === "rework") {
    const event = {
      type: "router-message",
      id: api.callId,
      ticketId: ticket.id,
      text: `验收未通过，需要返工：\n${args.note}`,
      whenBusy: "followUp",
    } as const;
    await deliver(api, route(event), context, (tx) => markHandled(tx, ticket.id));
    return ok(`已打回 ${ticket.id}。`);
  }

  await deliver(api, route({ type: "ticket-accepted", ticket, report: latest }), context, (tx) =>
    closeTicket(tx, ticket, "done", args.note ?? ""),
  );
  deps.jobs.stop(ticket.id);
  return ok(`${ticket.id} 已验收结单。`);
}

async function close(
  deps: OrchestrationDeps,
  ticket: Ticket,
  args: Args,
  api: ToolExecutionApi,
  context: Context,
) {
  if (!args.note) return fail("close 需要 note 写明原因。");
  await deliver(
    api,
    route({ type: "ticket-cancelled", ticket, reason: args.note }),
    context,
    (tx) => closeTicket(tx, ticket, "cancelled", args.note ?? ""),
  );
  deps.jobs.stop(ticket.id);
  await (await api.conversation(conversationOf(ticket), context))?.abort(context);
  return ok(`${ticket.id} 已取消。`);
}
