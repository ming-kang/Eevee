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
import type { TicketId } from "../contracts/index.ts";
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
