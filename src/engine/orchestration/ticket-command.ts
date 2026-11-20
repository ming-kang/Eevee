import type { ThinkingLevel, TicketId } from "../../domain/index.ts";
export type TicketArgs = {
  action: "create" | "message" | "interrupt" | "review" | "close" | "model";
  ticketId?: string;
  title?: string;
  goal?: string;
  inputs?: string[];
  acceptance?: string[];
  output?: string;
  dir?: string;
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
      dir?: string;
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
        ...(args.dir === undefined ? {} : { dir: args.dir }),
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

function missing<T extends object>(args: T, fields: readonly (keyof T)[]): string[] {
  return fields.filter((f) => args[f] === undefined || args[f] === "").map(String);
}
