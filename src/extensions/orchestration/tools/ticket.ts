import type { Context } from "@earendil-works/chord/context";
import { configure, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  agentModel,
  formatModel,
  latestFinalReport,
  type ModelChoice,
  problemOf,
  type Ticket,
  type TicketDetails,
  type TicketId,
} from "../../../contracts/index.ts";
import { conversationOf, markHandled, readReports, readTicket, saveTicket } from "../board.ts";
import { deliver } from "../deliver.ts";
import { route } from "../delivery.ts";
import { openTicket } from "../open.ts";
import type { OrchestrationDeps } from "../ports.ts";
import { fail, ok } from "../result.ts";
import { settle } from "../settle.ts";
import {
  type ModelRequest,
  Parameters,
  type Parsed,
  parseTicketCommand,
  type TicketCommand,
} from "./ticket-command.ts";

export const TICKET_TOOL = "ticket";

type Command<A extends TicketCommand["action"]> = Extract<TicketCommand, { action: A }>;

export function createTicketTool(deps: OrchestrationDeps) {
  return defineTool({
    name: TICKET_TOOL,
    description:
      "Manage tickets:\n" +
      "- create: make a ticket and start its worker conversation\n" +
      "- message: append an instruction to that conversation\n" +
      "- interrupt: abort the turn it is on\n" +
      "- review: handle a ready report (accept closes the ticket; rework sends it back)\n" +
      "- close: cancel a ticket\n" +
      "- model: switch the model of its worker conversation",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      const parsed = parseTicketCommand(args);
      if (!parsed.ok) return fail(parsed.reason);
      const command = parsed.value;
      if (command.action === "create") return create(deps, command, api, context);

      const ticket = await readTicket(api, command.ticketId, context);
      if (ticket === undefined) return fail(`No ticket ${command.ticketId}.`);
      if (ticket.status !== "open")
        return fail(
          `${ticket.id} is already ${ticket.status === "done" ? "closed" : "cancelled"}.`,
        );
      switch (command.action) {
        case "message":
          return message(ticket, command, api, context);
        case "interrupt":
          return interrupt(ticket, api, context);
        case "review":
          return review(ticket, command, api, context);
        case "close":
          return close(ticket, command, api, context);
        case "model":
          return retarget(ticket, command, api, context);
      }
    },
  });
}

async function create(
  deps: OrchestrationDeps,
  command: Command<"create">,
  api: ToolExecutionApi,
  context: Context,
) {
  // `create` may leave the model out and use the default one.
  const model = command.model === undefined ? undefined : resolveModel(command.model, api);
  if (model !== undefined && !model.ok) return fail(model.reason);
  for (const to of command.deliverTo) {
    const target = await readTicket(api, to, context);
    if (target?.status !== "open")
      return fail(`The ${to} in deliverTo does not exist or is already closed.`);
  }

  const ticket = await api.commit(
    (tx) =>
      openTicket(
        tx,
        deps.conversations,
        api.registry,
        {
          role: "worker",
          title: command.title,
          goal: command.goal,
          inputs: command.inputs,
          acceptance: command.acceptance,
          deliverTo: command.deliverTo,
          ...(command.output === undefined ? {} : { output: command.output }),
          ...(model?.value === undefined ? {} : { model: model.value }),
          ...(command.modelReason === undefined ? {} : { modelReason: command.modelReason }),
        },
        api.now(),
        context,
      ),
    context,
  );

  return ok(`Created ${ticket.id}; its worker conversation starts once a slot is free.`, {
    ticketId: ticket.id,
    conversationId: ticket.conversationId,
  } satisfies TicketDetails & { conversationId: number });
}

function resolveModel(request: ModelRequest, api: ToolExecutionApi): Parsed<ModelChoice> {
  if (api.models.getModel(request.provider, request.modelId) === undefined) {
    return {
      ok: false,
      reason: `No model ${request.provider}/${request.modelId}; see models:// for the available models.`,
    };
  }
  return {
    ok: true,
    value: {
      provider: request.provider,
      modelId: request.modelId,
      ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
    },
  };
}

async function message(
  ticket: Ticket,
  command: Command<"message">,
  api: ToolExecutionApi,
  context: Context,
) {
  const event = {
    type: "router-message",
    id: api.callId,
    ticketId: ticket.id,
    text: command.text,
    whenBusy: command.whenBusy,
  } as const;
  await deliver(api, route(event), context, (tx) => markHandled(tx, ticket.id));
  return ok(`Sent to ${ticket.id}.`);
}

async function interrupt(ticket: Ticket, api: ToolExecutionApi, context: Context) {
  await (await api.conversation(conversationOf(ticket), context))?.abort(context);
  await api.commit((tx) => markHandled(tx, ticket.id), context);
  return ok(`Interrupted the current turn of ${ticket.id}; the ticket is still open.`);
}

async function review(
  ticket: Ticket,
  command: Command<"review">,
  api: ToolExecutionApi,
  context: Context,
) {
  const latest = latestFinalReport(await readReports(api, ticket.id, context));
  if (latest?.status !== "ready" || latest.handled) {
    return fail(`${ticket.id} has no ready report waiting for review.`);
  }

  if (command.verdict === "rework") {
    const event = {
      type: "router-message",
      id: api.callId,
      ticketId: ticket.id,
      text: `Review did not pass, rework needed:\n${command.note}`,
      whenBusy: "followUp",
    } as const;
    await deliver(api, route(event), context, (tx) => markHandled(tx, ticket.id));
    return ok(`Sent ${ticket.id} back for rework.`);
  }

  try {
    await deliver(api, route({ type: "ticket-accepted", ticket, report: latest }), context, (tx) =>
      settle(
        tx,
        ticket.id,
        { status: "done", note: command.note, at: api.now() },
        { reportSeq: latest.seq },
      ),
    );
  } catch (error) {
    return fail(settleRefusal(error, ticket.id));
  }
  return ok(`${ticket.id} is accepted and closed.`);
}

async function close(
  ticket: Ticket,
  command: Command<"close">,
  api: ToolExecutionApi,
  context: Context,
) {
  try {
    await deliver(
      api,
      route({ type: "ticket-cancelled", ticket, reason: command.note }),
      context,
      (tx) => settle(tx, ticket.id, { status: "cancelled", note: command.note, at: api.now() }),
    );
  } catch (error) {
    return fail(settleRefusal(error, ticket.id));
  }
  return ok(`${ticket.id} is cancelled.`);
}

async function retarget(
  ticket: Ticket,
  command: Command<"model">,
  api: ToolExecutionApi,
  context: Context,
) {
  const model = resolveModel(command.model, api);
  if (!model.ok) return fail(model.reason);
  await api.commit(async (tx) => {
    const { modelReason: _, ...rest } = ticket;
    await saveTicket(tx, {
      ...rest,
      model: model.value,
      ...(command.modelReason === undefined ? {} : { modelReason: command.modelReason }),
    });
    await configure(tx, conversationOf(ticket), agentModel(model.value));
    await markHandled(tx, ticket.id);
  }, context);
  const thinking =
    model.value.thinkingLevel === undefined ? "" : `, thinking level ${model.value.thinkingLevel}`;
  return ok(
    `${ticket.id} now uses ${formatModel(model.value)}${thinking}, starting from its next request.`,
  );
}

function settleRefusal(error: unknown, ticketId: TicketId): string {
  const code = problemOf(error).code;
  if (code === "ticket_closed") return `${ticketId} is already closed.`;
  if (code === "report_changed")
    return `The report waiting on ${ticketId} changed; read the latest one first.`;
  throw error;
}
