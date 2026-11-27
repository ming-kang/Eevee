import { applyImmutable, assertValidOp, type Op } from "@earendil-works/chord/delta";
import {
  type ConversationRef,
  type OkResponse,
  OkResponseSchema,
  type ScanOrder,
  type StreamEndEvent,
  StreamEndEventSchema,
} from "../schemas/common.ts";
import {
  ConversationFailedEventSchema,
  ConversationPatchEventSchema,
  ConversationSnapshotEventSchema,
  type ConversationViewPayload,
  type ListEntriesResponse,
  ListEntriesResponseSchema,
  type SendMessageRequest,
  type SendMessageResponse,
  SendMessageResponseSchema,
} from "../schemas/project.ts";
import { buildQuery, type HttpTransport } from "./transport.ts";

export type ConversationStreamEvent =
  | {
      readonly type: "snapshot";
      readonly view: ConversationViewPayload;
      readonly eventId?: string;
    }
  | {
      readonly type: "patch";
      readonly ops: readonly Op[];
      readonly retired: boolean;
      readonly view: ConversationViewPayload;
      readonly eventId?: string;
    }
  | { readonly type: "failed"; readonly message: string }
  | {
      readonly type: "end";
      readonly reason: StreamEndEvent["reason"];
      readonly message?: string;
    };

export type StreamConversationOptions = {
  readonly from?: number;
  readonly min?: number;
  readonly max?: number;
  readonly lastEventId?: string | number;
  readonly signal?: AbortSignal;
};

export type ListEntriesOptions = {
  readonly order?: ScanOrder;
  readonly limit?: number;
  readonly minEntryId?: number;
  readonly maxEntryId?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
};

export class ConversationsClient {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.#transport = transport;
  }

  sendMessage(
    projectId: string,
    ref: ConversationRef,
    input: SendMessageRequest,
    signal?: AbortSignal,
  ): Promise<SendMessageResponse> {
    return this.#transport.post(
      `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ref)}/messages`,
      SendMessageResponseSchema,
      input,
      signal,
    );
  }

  listEntries(
    projectId: string,
    ref: ConversationRef,
    opts?: ListEntriesOptions,
  ): Promise<ListEntriesResponse> {
    const query = buildQuery({
      order: opts?.order,
      limit: opts?.limit,
      minEntryId: opts?.minEntryId,
      maxEntryId: opts?.maxEntryId,
      cursor: opts?.cursor,
    });
    return this.#transport.get(
      `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ref)}/entries${query}`,
      ListEntriesResponseSchema,
      opts?.signal,
    );
  }

  interrupt(projectId: string, ref: ConversationRef, signal?: AbortSignal): Promise<OkResponse> {
    return this.#transport.post(
      `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ref)}/interrupt`,
      OkResponseSchema,
      undefined,
      signal,
    );
  }

  retry(
    projectId: string,
    ref: ConversationRef,
    signal?: AbortSignal,
  ): Promise<SendMessageResponse> {
    return this.#transport.post(
      `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ref)}/retry`,
      SendMessageResponseSchema,
      undefined,
      signal,
    );
  }

  async *streamConversation(
    projectId: string,
    ref: ConversationRef,
    opts?: StreamConversationOptions,
  ): AsyncGenerator<ConversationStreamEvent> {
    const query = buildQuery({ from: opts?.from, min: opts?.min, max: opts?.max });
    const path = `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(ref)}/stream${query}`;
    const extraHeaders =
      opts?.lastEventId === undefined ? undefined : { "Last-Event-ID": String(opts.lastEventId) };

    let currentView: ConversationViewPayload | undefined;
    for await (const sse of this.#transport.streamSse(path, opts?.signal, extraHeaders)) {
      if (sse.event === "snapshot") {
        const parsed = this.#transport.decodeSseEvent(
          sse,
          ConversationSnapshotEventSchema,
          "conversation snapshot SSE payload",
        );
        currentView = parsed.view;
        yield {
          type: "snapshot",
          view: currentView,
          ...(sse.id === undefined ? {} : { eventId: sse.id }),
        };
      } else if (sse.event === "patch") {
        if (currentView === undefined) {
          throw new Error("Received conversation patch before initial snapshot");
        }
        const parsed = this.#transport.decodeSseEvent(
          sse,
          ConversationPatchEventSchema,
          "conversation patch SSE payload",
        );
        for (const op of parsed.ops) assertValidOp(op);
        const ops = parsed.ops as Op[];
        currentView = applyImmutable(currentView, ops);
        yield {
          type: "patch",
          ops,
          retired: parsed.retired,
          view: currentView,
          ...(sse.id === undefined ? {} : { eventId: sse.id }),
        };
      } else if (sse.event === "failed") {
        const parsed = this.#transport.decodeSseEvent(
          sse,
          ConversationFailedEventSchema,
          "conversation failed SSE payload",
        );
        yield { type: "failed", message: parsed.message };
      } else if (sse.event === "end") {
        const parsed = this.#transport.decodeSseEvent(
          sse,
          StreamEndEventSchema,
          "conversation end SSE payload",
        );
        yield {
          type: "end",
          reason: parsed.reason,
          ...(parsed.message === undefined ? {} : { message: parsed.message }),
        };
        return;
      }
    }
  }
}
