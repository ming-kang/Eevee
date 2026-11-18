import type { Context } from "@earendil-works/chord/context";
import { configure, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  agentModel,
  formatModel,
  latestFinalReport,
  type ModelChoice,
  problemOf,
  THINKING_LEVELS,
  type ThinkingLevel,
  type Ticket,
  type TicketDetails,
  type TicketId,
} from "../../../contracts/index.ts";
import {
  conversationOf,
  markHandled,
  readQuestions,
  readReports,
  readTicket,
  saveTicket,
  settleTicket,
} from "../board.ts";
import { deliver, purgeDeliveries } from "../deliver.ts";
import { route } from "../delivery.ts";
import { openTicket } from "../open.ts";
import type { OrchestrationDeps } from "../ports.ts";
import { fail, missing, ok } from "../result.ts";

export const TICKET_TOOL = "ticket";

const TICKET_ID = "^t[1-9][0-9]*$";

const Parameters = obj({
  action: oneOf(["create", "message", "interrupt", "review", "close", "model"]),
  ticketId: opt(
    str({
      pattern: TICKET_ID,
      description: "The ticket to act on, e.g. t3; required for every action but create",
    }),
  ),
  title: opt(str({ description: "create: a short title" })),
  goal: opt(str({ description: "create: what the ticket should achieve" })),
  inputs: opt(arr(str(), { description: "create: input file paths or resource addresses" })),
  acceptance: opt(arr(str(), { description: "create: the acceptance criteria" })),
  output: opt(str({ description: "create: where the artifacts are written" })),
  deliverTo: opt(
    arr(str({ pattern: TICKET_ID }), {
      description: "create: tickets that receive the results after review",
    }),
  ),
  provider: opt(
    str({
      description:
        "create / model: the model provider, see models://; leave it out on create to use the default model",
    }),
  ),
  modelId: opt(str({ description: "create / model: the model id" })),
  thinkingLevel: opt(
    oneOf(THINKING_LEVELS, {
      description:
        "create / model: the thinking level, from off to max, filled in together with provider and modelId; defaults to off",
    }),
  ),
  modelReason: opt(
    str({ description: "create / model: why this model instead of the default one" }),
  ),
  text: opt(str({ description: "message: the instruction to append" })),
  mode: opt(
    oneOf(["steer", "followUp"], { description: "message: steer or queue, queues by default" }),
  ),
  verdict: opt(
    oneOf(["accept", "rework"], { description: "review: accept the report or send it back" }),
  ),
  note: opt(
    str({
      description: "review accept: the evidence / rework: what is missing / close: the reason",
    }),
  ),
});

type Args = {
  action: "create" | "message" | "interrupt" | "review" | "close" | "model";
  ticketId?: string;
  title?: string;
  goal?: string;
  inputs?: string[];
  acceptance?: string[];
  output?: string;
  deliverTo?: string[];
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
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
      "Manage tickets. create makes one and starts its worker conversation; message appends an instruction to " +
      "that conversation; interrupt aborts the turn it is on; review handles a ready report (accept closes " +
      "the ticket, rework sends it back); close cancels a ticket; model switches the model of its worker conversation.",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      if (args.action === "create") return create(deps, args, api, context);
      if (args.ticketId === undefined) return fail(`${args.action} needs a ticketId.`);
      const ticket = await readTicket(api, args.ticketId as TicketId, context);
      if (ticket === undefined) return fail(`No ticket ${args.ticketId}.`);
      if (ticket.status !== "open")
        return fail(
          `${ticket.id} is already ${ticket.status === "done" ? "closed" : "cancelled"}.`,
        );
      switch (args.action) {
        case "message":
          return message(ticket, args, api, context);
        case "interrupt":
          return interrupt(ticket, api, context);
        case "review":
          return review(deps, ticket, args, api, context);
        case "close":
          return close(deps, ticket, args, api, context);
        case "model":
          return retarget(ticket, args, api, context);
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
  if (absent.length > 0) return fail(`create is missing fields: ${absent.join(", ")}.`);
  if ((args.provider === undefined) !== (args.modelId === undefined)) {
    return fail(
      "provider and modelId are filled in together or left out together (to use the default model).",
    );
  }
  if (args.thinkingLevel !== undefined && args.provider === undefined) {
    return fail(
      "thinkingLevel goes together with provider and modelId; see models:// for the default model.",
    );
  }
  const model = chosenModel(args, api);
  if (typeof model === "string") return fail(model);
  const deliverTo = (args.deliverTo ?? []) as TicketId[];
  for (const to of deliverTo) {
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
          title: args.title ?? "",
          goal: args.goal ?? "",
          inputs: args.inputs ?? [],
          acceptance: args.acceptance ?? [],
          deliverTo,
          ...(args.output ? { output: args.output } : {}),
          ...(model === undefined ? {} : { model }),
          ...(args.modelReason ? { modelReason: args.modelReason } : {}),
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

/** The model the arguments name, `undefined` for the default, or why it cannot be used. */
function chosenModel(args: Args, api: ToolExecutionApi): ModelChoice | undefined | string {
  if (args.provider === undefined || args.modelId === undefined) return undefined;
  if (api.models.getModel(args.provider, args.modelId) === undefined) {
    return `No model ${args.provider}/${args.modelId}; see models:// for the available models.`;
  }
  return {
    provider: args.provider,
    modelId: args.modelId,
    ...(args.thinkingLevel === undefined ? {} : { thinkingLevel: args.thinkingLevel }),
  };
}

async function message(ticket: Ticket, args: Args, api: ToolExecutionApi, context: Context) {
  if (!args.text) return fail("message needs text.");
  const event = {
    type: "router-message",
    id: api.callId,
    ticketId: ticket.id,
    text: args.text,
    whenBusy: args.mode ?? "followUp",
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
  deps: OrchestrationDeps,
  ticket: Ticket,
  args: Args,
  api: ToolExecutionApi,
  context: Context,
) {
  if (args.verdict === undefined || !args.note) return fail("review needs verdict and note.");
  const latest = latestFinalReport(await readReports(api, ticket.id, context));
  if (latest?.status !== "ready" || latest.handled) {
    return fail(`${ticket.id} has no ready report waiting for review.`);
  }

  if (args.verdict === "rework") {
    const event = {
      type: "router-message",
      id: api.callId,
      ticketId: ticket.id,
      text: `Review did not pass, rework needed:\n${args.note}`,
      whenBusy: "followUp",
    } as const;
    await deliver(api, route(event), context, (tx) => markHandled(tx, ticket.id));
    return ok(`Sent ${ticket.id} back for rework.`);
  }

  const questions = (await readQuestions(api, context)).filter(
    (question) => question.ticketId === ticket.id,
  );
  try {
    await deliver(
      api,
      route({ type: "ticket-accepted", ticket, report: latest }),
      context,
      async (tx) => {
        await settleTicket(
          tx,
          ticket,
          { status: "done", note: args.note ?? "", at: api.now() },
          { reportSeq: latest.seq, questions },
        );
        await purgeDeliveries(tx, ticket.id);
      },
    );
  } catch (error) {
    return fail(settleRefusal(error, ticket.id));
  }
  deps.jobs.stop(ticket.id);
  await (await api.conversation(conversationOf(ticket), context))?.abort(context);
  return ok(`${ticket.id} is accepted and closed.`);
}

async function close(
  deps: OrchestrationDeps,
  ticket: Ticket,
  args: Args,
  api: ToolExecutionApi,
  context: Context,
) {
  if (!args.note) return fail("close needs a note that says why.");
  const questions = (await readQuestions(api, context)).filter(
    (question) => question.ticketId === ticket.id,
  );
  try {
    await deliver(
      api,
      route({ type: "ticket-cancelled", ticket, reason: args.note }),
      context,
      async (tx) => {
        await settleTicket(
          tx,
          ticket,
          { status: "cancelled", note: args.note ?? "", at: api.now() },
          { questions },
        );
        await purgeDeliveries(tx, ticket.id);
      },
    );
  } catch (error) {
    return fail(settleRefusal(error, ticket.id));
  }
  deps.jobs.stop(ticket.id);
  await (await api.conversation(conversationOf(ticket), context))?.abort(context);
  return ok(`${ticket.id} is cancelled.`);
}

async function retarget(ticket: Ticket, args: Args, api: ToolExecutionApi, context: Context) {
  if (args.provider === undefined || args.modelId === undefined) {
    return fail("model needs provider and modelId.");
  }
  const model = chosenModel(args, api);
  if (typeof model === "string" || model === undefined) return fail(model ?? "");
  await api.commit(async (tx) => {
    const { modelReason: _, ...rest } = ticket;
    await saveTicket(tx, {
      ...rest,
      model,
      ...(args.modelReason ? { modelReason: args.modelReason } : {}),
    });
    await configure(tx, conversationOf(ticket), agentModel(model));
    await markHandled(tx, ticket.id);
  }, context);
  const thinking =
    model.thinkingLevel === undefined ? "" : `, thinking level ${model.thinkingLevel}`;
  return ok(`${ticket.id} now uses ${formatModel(model)}${thinking}, from its next request on.`);
}

/** Why a terminal transition could not be written, in the Router's words. */
function settleRefusal(error: unknown, ticketId: TicketId): string {
  const code = problemOf(error).code;
  if (code === "ticket_closed") return `${ticketId} is already closed.`;
  if (code === "report_changed")
    return `The report waiting on ${ticketId} changed; read the latest one first.`;
  throw error;
}
