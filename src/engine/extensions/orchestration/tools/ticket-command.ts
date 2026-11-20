import { arr, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { THINKING_LEVELS, type ThinkingLevel, type TicketId } from "../../../../domain/index.ts";
import { missing } from "../result.ts";

const TICKET_ID = "^t[1-9][0-9]*$";

/**
 * The `ticket` tool's parameters: flat on purpose, so the model sees one tool with one action field instead of
 * six tools. `parseTicketCommand` turns them into the command each handler needs.
 */
export const Parameters = obj({
  action: oneOf(["create", "message", "interrupt", "review", "close", "model"]),
  ticketId: opt(
    str({
      pattern: TICKET_ID,
      description: "The ticket to act on, e.g. t3. Every action except create requires it.",
    }),
  ),
  title: opt(str({ description: "create: a short title for the ticket" })),
  goal: opt(str({ description: "create: what the ticket should achieve" })),
  inputs: opt(arr(str(), { description: "create: the input file paths or resource addresses" })),
  acceptance: opt(
    arr(str(), { description: "create: the acceptance criteria the work must meet" }),
  ),
  output: opt(str({ description: "create: where the artifacts are written" })),
  deliverTo: opt(
    arr(str({ pattern: TICKET_ID }), {
      description: "create: tickets that receive the result after review",
    }),
  ),
  provider: opt(
    str({
      description:
        "create and model: the model provider; see models://. On create, leave it out to use the default model.",
    }),
  ),
  modelId: opt(str({ description: "create and model: the model ID" })),
  thinkingLevel: opt(
    oneOf(THINKING_LEVELS, {
      description:
        "create and model: the thinking level, from off to max. Set it together with provider and modelId; it defaults to off.",
    }),
  ),
  modelReason: opt(
    str({ description: "create and model: why this model instead of the default one" }),
  ),
  text: opt(str({ description: "message: the instruction to append to the conversation" })),
  mode: opt(
    oneOf(["steer", "followUp"], {
      description:
        "message: steer to cut in on the current turn, or followUp to queue behind it. followUp is the default.",
    }),
  ),
  verdict: opt(
    oneOf(["accept", "rework"], {
      description: "review: accept approves the report, or rework sends it back",
    }),
  ),
  note: opt(
    str({
      description:
        "review accept: the evidence that it passed; review rework: what is missing; close: the reason for cancelling",
    }),
  ),
});

export type TicketArgs = Static<typeof Parameters>;

export type ModelRequest = {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

/** One action of the `ticket` tool, with every field it needs present and every default filled in. */
export type TicketCommand =
  | {
      action: "create";
      title: string;
      goal: string;
      acceptance: string[];
      inputs: string[];
      deliverTo: TicketId[];
      output?: string;
      model?: ModelRequest;
      modelReason?: string;
    }
  | { action: "message"; ticketId: TicketId; text: string; whenBusy: "steer" | "followUp" }
  | { action: "interrupt"; ticketId: TicketId }
  | { action: "review"; ticketId: TicketId; verdict: "accept" | "rework"; note: string }
  | { action: "close"; ticketId: TicketId; note: string }
  | { action: "model"; ticketId: TicketId; model: ModelRequest; modelReason?: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Checks the arguments and fills in the defaults, so every handler receives only its own action, complete.
 * The cheap field checks come first; whether the ticket exists and is still open is the caller's business.
 */
export function parseTicketCommand(args: TicketArgs): Parsed<TicketCommand> {
  if (args.action === "create") {
    const absent = missing(args, ["title", "goal", "acceptance"]);
    if (absent.length > 0)
      return { ok: false, reason: `create is missing fields: ${absent.join(", ")}.` };
    const model = optionalModel(args);
    if (!model.ok) return model;
    return {
      ok: true,
      value: {
        action: "create",
        title: args.title ?? "",
        goal: args.goal ?? "",
        acceptance: args.acceptance ?? [],
        inputs: args.inputs ?? [],
        deliverTo: (args.deliverTo ?? []) as TicketId[],
        ...(args.output === undefined ? {} : { output: args.output }),
        ...(model.value === undefined ? {} : { model: model.value }),
        ...(args.modelReason === undefined ? {} : { modelReason: args.modelReason }),
      },
    };
  }

  const ticketId = args.ticketId as TicketId | undefined;
  if (ticketId === undefined) return { ok: false, reason: `${args.action} needs a ticketId.` };
  switch (args.action) {
    case "message":
      if (!args.text) return { ok: false, reason: "message needs text." };
      return {
        ok: true,
        value: {
          action: "message",
          ticketId,
          text: args.text,
          whenBusy: args.mode ?? "followUp",
        },
      };

    case "interrupt":
      return { ok: true, value: { action: "interrupt", ticketId } };

    case "review":
      if (args.verdict === undefined || !args.note) {
        return { ok: false, reason: "review needs verdict and note." };
      }
      return {
        ok: true,
        value: { action: "review", ticketId, verdict: args.verdict, note: args.note },
      };

    case "close":
      if (!args.note) return { ok: false, reason: "close needs a note that says why." };
      return { ok: true, value: { action: "close", ticketId, note: args.note } };

    case "model": {
      const model = requiredModel(args);
      if (!model.ok) return model;
      return {
        ok: true,
        value: {
          action: "model",
          ticketId,
          model: model.value,
          ...(args.modelReason === undefined ? {} : { modelReason: args.modelReason }),
        },
      };
    }
  }
}

/** The model the arguments name, or why its fields cannot be used together; absent for the default one. */
function optionalModel(args: TicketArgs): Parsed<ModelRequest | undefined> {
  const { provider, modelId, thinkingLevel } = args;
  if (provider === undefined && modelId === undefined) {
    if (thinkingLevel !== undefined) {
      return {
        ok: false,
        reason:
          "thinkingLevel goes together with provider and modelId; see models:// for the default model.",
      };
    }
    return { ok: true, value: undefined };
  }
  if (provider === undefined || modelId === undefined) {
    return {
      ok: false,
      reason:
        "provider and modelId are filled in together or left out together (to use the default model).",
    };
  }
  return {
    ok: true,
    value: { provider, modelId, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) },
  };
}

function requiredModel(args: TicketArgs): Parsed<ModelRequest> {
  if (args.provider === undefined || args.modelId === undefined) {
    return { ok: false, reason: "model needs provider and modelId." };
  }
  return {
    ok: true,
    value: {
      provider: args.provider,
      modelId: args.modelId,
      ...(args.thinkingLevel === undefined ? {} : { thinkingLevel: args.thinkingLevel }),
    },
  };
}
