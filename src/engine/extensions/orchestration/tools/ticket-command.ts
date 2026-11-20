import { arr, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { THINKING_LEVELS } from "../../../../domain/index.ts";

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
