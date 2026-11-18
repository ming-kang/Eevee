/**
 * The realtime stream: one WebSocket at `/api/stream` per page, carrying any number of watches.
 *
 * The page connects with the subprotocols `eevee.v1` and `token.<session token>` (browsers cannot set headers on a
 * WebSocket); the Engine answers with `eevee.v1` only, so the token never echoes back. The first event is `hello` with
 * the Engine's `bootId`: a page that sees it change after a reconnect starts its watches over.
 *
 * - A conversation watch forwards Durable's `Conversation.watch()`: one `value` with the structural view, then `ops`
 *   that turn each value into the next. A client keeps its transcript with `ConversationTranscript`, and after a
 *   reconnect watches again with `transcript.resume` as the window; `entries` fills the gaps it reports.
 * - A board watch sends the whole board whenever it changed.
 */
import type { Op } from "@earendil-works/chord/delta";
import type {
  ConversationView,
  ConversationWindow,
  EntryQuery,
  EntryRecord,
} from "@earendil-works/pi-durable";
import { compile, int, obj, oneOf, opt, str, unsafe } from "@earendil-works/pi-schema";
import type { TicketId } from "../contracts/index.ts";
import { ProblemError } from "../contracts/index.ts";
import type { BoardView, ProblemBody } from "./contract.ts";

export const STREAM_PATH = "/api/stream";
export const STREAM_PROTOCOL = "eevee.v1";
export const TOKEN_PROTOCOL_PREFIX = "token.";

/** The Router's conversation without `ticket`, else that ticket's. */
export type ConversationTopic = { kind: "conversation"; project: string; ticket?: TicketId };
export type BoardTopic = { kind: "board"; project: string };

export type StreamRequest =
  | { type: "watch"; id: string; topic: ConversationTopic; window?: ConversationWindow }
  | { type: "watch"; id: string; topic: BoardTopic }
  | { type: "unwatch"; id: string }
  | {
      type: "entries";
      id: string;
      topic: ConversationTopic;
      query: Omit<EntryQuery, "conversationId">;
      limit: number;
    };

export type StreamEvent =
  | { type: "hello"; bootId: string }
  | { type: "value"; id: string; value: ConversationView }
  | { type: "ops"; id: string; ops: readonly Op[] }
  | { type: "board"; id: string; board: BoardView }
  | { type: "entries"; id: string; items: EntryRecord[] }
  /** The watch ended on its own, for good: `ended` when its source closed, `failed`, `listener_error`. */
  | { type: "end"; id: string; reason: string }
  | { type: "error"; id?: string; error: ProblemBody };

const TICKET_PATTERN = "^t[1-9][0-9]*$";

const TopicSchema = obj({
  kind: oneOf(["conversation", "board"]),
  project: str({ minLength: 1 }),
  ticket: opt(str({ pattern: TICKET_PATTERN })),
});

/** What a client may send on the stream; anything else is refused before it reaches a handler. */
export const StreamRequestSchema = obj({
  type: oneOf(["watch", "unwatch", "entries"]),
  id: str({ minLength: 1 }),
  topic: opt(TopicSchema),
  window: opt(unsafe<ConversationWindow>({ type: "object" })),
  limit: opt(int({ minimum: 1 })),
  query: opt(unsafe<Omit<EntryQuery, "conversationId">>({ type: "object" })),
});

const validateRequest = compile(StreamRequestSchema);

const invalid = (field: string): ProblemError => new ProblemError({ code: "invalid", field });

/** The request `value` describes, or a Problem naming what is missing or wrong. */
export function parseStreamRequest(value: unknown): StreamRequest {
  const parsed = validateRequest.validate(value);
  if (!parsed.ok) {
    const path = parsed.errors[0]?.path ?? "";
    throw invalid(path.replace(/^\//, "").replaceAll("/", ".") || "request");
  }
  const request = parsed.value;
  if (request.type === "unwatch") return { type: "unwatch", id: request.id };
  const topic = request.topic;
  if (topic === undefined) throw invalid("topic");
  if (request.type === "entries") {
    if (request.query === undefined) throw invalid("query");
    if (request.limit === undefined) throw invalid("limit");
    return {
      type: "entries",
      id: request.id,
      topic: conversationTopic(topic),
      query: request.query,
      limit: request.limit,
    };
  }
  if (topic.kind === "board") {
    return { type: "watch", id: request.id, topic: { kind: "board", project: topic.project } };
  }
  const window = request.window;
  return {
    type: "watch",
    id: request.id,
    topic: conversationTopic(topic),
    ...(window === undefined ? {} : { window }),
  };
}

function conversationTopic(topic: {
  kind: "conversation" | "board";
  project: string;
  ticket?: string;
}): ConversationTopic {
  if (topic.kind !== "conversation") throw invalid("topic.kind");
  return {
    kind: "conversation",
    project: topic.project,
    ...(topic.ticket === undefined ? {} : { ticket: topic.ticket as TicketId }),
  };
}
