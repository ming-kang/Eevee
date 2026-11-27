import {
  arr,
  bool,
  int,
  map,
  num,
  obj,
  opt,
  type Static,
  str,
  unknown,
} from "@earendil-works/pi-schema";

export * from "./conversation-docs.ts";

export const ConversationRecordSchema = obj(
  {
    id: int({ minimum: 1 }),
    parent: opt(obj({ conversationId: int({ minimum: 1 }), at: int({ minimum: 1 }) })),
    owner: opt(obj({ conversationId: int({ minimum: 1 }), taskId: int({ minimum: 1 }) })),
  },
  { open: true },
);
export type ConversationRecordPayload = Static<typeof ConversationRecordSchema>;

export const EntryModelMessageSchema = obj(
  {
    role: str({ minLength: 1 }),
    content: opt(unknown()),
    toolName: opt(str()),
    toolCallId: opt(str()),
    isError: opt(bool()),
    stopReason: opt(str()),
    errorMessage: opt(str()),
    timestamp: opt(num()),
    usage: opt(
      obj(
        {
          input: opt(num()),
          output: opt(num()),
          cacheRead: opt(num()),
          cacheWrite: opt(num()),
          totalTokens: opt(num()),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);
export type EntryModelMessagePayload = Static<typeof EntryModelMessageSchema>;

export const EntryRecordSchema = obj(
  {
    id: int({ minimum: 1 }),
    conversationId: int({ minimum: 1 }),
    kind: str({ minLength: 1 }),
    model: opt(arr(EntryModelMessageSchema)),
    data: opt(unknown()),
    head: opt(int({ minimum: 1 })),
    edits: opt(arr(obj({}, { open: true }))),
    byTaskId: opt(int({ minimum: 1 })),
  },
  { open: true },
);
export type EntryRecordPayload = Static<typeof EntryRecordSchema>;

export const ConversationViewPayloadSchema = obj({
  conversation: ConversationRecordSchema,
  entries: arr(EntryRecordSchema),
  before: opt(int({ minimum: 1 })),
  docs: map(obj({}, { open: true })),
});
export type ConversationViewPayload = Static<typeof ConversationViewPayloadSchema>;

export const ConversationSnapshotEventSchema = obj({ view: ConversationViewPayloadSchema });
export type ConversationSnapshotEvent = Static<typeof ConversationSnapshotEventSchema>;

export const ConversationPatchEventSchema = obj({ ops: arr(unknown()), retired: bool() });
export type ConversationPatchEvent = Static<typeof ConversationPatchEventSchema>;

export const ConversationFailedEventSchema = obj({ message: str({ minLength: 1 }) });
export type ConversationFailedEvent = Static<typeof ConversationFailedEventSchema>;

export const ListEntriesResponseSchema = obj({
  entries: arr(EntryRecordSchema),
  nextCursor: opt(str({ minLength: 1 })),
});
export type ListEntriesResponse = Static<typeof ListEntriesResponseSchema>;
