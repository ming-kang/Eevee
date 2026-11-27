import {
  arr,
  bool,
  int,
  lit,
  num,
  obj,
  oneOf,
  opt,
  type Schema,
  type Static,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";
import {
  BackgroundTaskStatusSchema,
  QuestionIdSchema,
  TaskCancelReasonSchema,
  ThinkingLevelSchema,
  TicketIdSchema,
  validateWithSchema,
  WorkerIdSchema,
} from "./common.ts";

export const TextContentBlockSchema = obj(
  { type: lit("text"), text: str(), textSignature: opt(str()) },
  { open: true },
);
export type TextContentBlock = Static<typeof TextContentBlockSchema>;

export const ThinkingContentBlockSchema = obj(
  {
    type: lit("thinking"),
    thinking: str(),
    thinkingSignature: opt(str()),
    redacted: opt(bool()),
  },
  { open: true },
);
export type ThinkingContentBlock = Static<typeof ThinkingContentBlockSchema>;

export const ImageContentBlockSchema = obj(
  { type: lit("image"), data: str(), mimeType: str() },
  { open: true },
);
export type ImageContentBlock = Static<typeof ImageContentBlockSchema>;

export const ToolCallContentBlockSchema = obj(
  {
    type: lit("toolCall"),
    id: str(),
    name: str(),
    arguments: opt(obj({}, { open: true })),
    thoughtSignature: opt(str()),
    namespace: opt(str()),
    argumentsError: opt(str()),
  },
  { open: true },
);
export type ToolCallContentBlock = Static<typeof ToolCallContentBlockSchema>;

export const ContentBlockSchema = union([
  TextContentBlockSchema,
  ThinkingContentBlockSchema,
  ImageContentBlockSchema,
  ToolCallContentBlockSchema,
]);
export type ContentBlock = Static<typeof ContentBlockSchema>;

export const LiveToolSlotStatusSchema = oneOf([
  "pending",
  "running",
  "sleeping",
  "waiting",
  "done",
]);
export type LiveToolSlotStatus = Static<typeof LiveToolSlotStatusSchema>;

export const LiveToolDiagnosticSchema = obj(
  { severity: str(), message: str(), code: opt(str()) },
  { open: true },
);
export type LiveToolDiagnostic = Static<typeof LiveToolDiagnosticSchema>;

export const LiveToolSlotSchema = obj(
  {
    callId: str(),
    name: str(),
    status: LiveToolSlotStatusSchema,
    output: opt(str()),
    droppedBytes: opt(num()),
    droppedLines: opt(num()),
    details: opt(unknown()),
    diagnostics: opt(arr(LiveToolDiagnosticSchema)),
    taskId: opt(num()),
    unoffered: opt(lit(true)),
    entry: opt(num()),
  },
  { open: true },
);
export type LiveToolSlot = Static<typeof LiveToolSlotSchema>;

export const LiveRunFailureSchema = obj(
  {
    taskId: opt(num()),
    inputs: opt(arr(num())),
    reason: str(),
    detail: opt(str()),
    first: opt(num()),
  },
  { open: true },
);
export type LiveRunFailure = Static<typeof LiveRunFailureSchema>;

export const LiveDocPayloadSchema = obj(
  {
    run: opt(
      obj(
        {
          taskId: opt(num()),
          inputs: opt(arr(num())),
          turns: opt(num()),
          first: opt(num()),
        },
        { open: true },
      ),
    ),
    generation: opt(
      obj(
        {
          attempt: opt(num()),
          message: opt(
            obj(
              {
                role: opt(str()),
                content: opt(union([str(), arr(ContentBlockSchema)])),
              },
              { open: true },
            ),
          ),
          retry: opt(obj({ at: opt(num()), error: str() }, { open: true })),
          deferred: opt(obj({ pollAt: opt(num()) }, { open: true })),
        },
        { open: true },
      ),
    ),
    tools: opt(arr(LiveToolSlotSchema)),
    nestedTools: opt(arr(obj({}, { open: true }))),
    compactions: opt(arr(obj({}, { open: true }))),
    compactionFailure: opt(obj({}, { open: true })),
    runFailure: opt(LiveRunFailureSchema),
  },
  { open: true },
);
export type LiveDocPayload = Static<typeof LiveDocPayloadSchema>;

export const InboxInputItemSchema = obj(
  {
    id: num(),
    mode: oneOf(["steer", "followUp"]),
    content: union([str(), arr(ContentBlockSchema)]),
    entry: opt(obj({ kind: str(), data: opt(unknown()) }, { open: true })),
    onAbort: opt(lit("keep")),
  },
  { open: true },
);
export const InboxWriteItemSchema = obj(
  { id: num(), mode: lit("write"), entry: obj({}, { open: true }) },
  { open: true },
);
export const InboxItemSchema = union([InboxInputItemSchema, InboxWriteItemSchema]);
export type InboxItem = Static<typeof InboxItemSchema>;

export const InboxDocPayloadSchema = obj({ items: opt(arr(InboxItemSchema)) }, { open: true });
export type InboxDocPayload = Static<typeof InboxDocPayloadSchema>;

export const AgentDocPayloadSchema = obj(
  {
    model: opt(obj({ provider: str({ minLength: 1 }), modelId: str({ minLength: 1 }) })),
    thinkingLevel: opt(ThinkingLevelSchema),
    extensions: opt(
      union([arr(str()), obj({ add: opt(arr(str())), remove: opt(arr(str())) }, { open: true })]),
    ),
    tools: opt(union([arr(str()), obj({ remove: arr(str()) }, { open: true })])),
    modelTools: opt(
      union([arr(str()), obj({ remove: opt(arr(str())), add: opt(arr(str())) }, { open: true })]),
    ),
    instructions: opt(str()),
    cwd: opt(str()),
    maxTurns: opt(int({ minimum: 1 })),
    compaction: opt(obj({}, { open: true })),
  },
  { open: true },
);
export type AgentDocPayload = Static<typeof AgentDocPayloadSchema>;

export const WorkerFailedNoticeDataSchema = obj(
  {
    type: lit("worker_failed"),
    workerId: WorkerIdSchema,
    workerName: str(),
    ticketId: opt(TicketIdSchema),
    taskId: opt(num()),
    reason: str(),
    detail: opt(str()),
  },
  { open: true },
);

export const HandoffNoticeDataSchema = obj(
  {
    type: lit("handoff"),
    workerId: WorkerIdSchema,
    workerName: str(),
    ticketId: opt(TicketIdSchema),
    answerEntryId: opt(num()),
  },
  { open: true },
);

export const WorkerMessageNoticeDataSchema = obj(
  {
    type: lit("worker_message"),
    workerId: WorkerIdSchema,
    workerName: str(),
    ticketId: opt(TicketIdSchema),
  },
  { open: true },
);

export const QuestionAnsweredNoticeDataSchema = obj(
  {
    type: lit("question_answered"),
    questionId: QuestionIdSchema,
    answers: arr(str()),
  },
  { open: true },
);

export const NoticeDataSchema = union([
  WorkerFailedNoticeDataSchema,
  HandoffNoticeDataSchema,
  WorkerMessageNoticeDataSchema,
  QuestionAnsweredNoticeDataSchema,
]);
export type NoticeData = Static<typeof NoticeDataSchema>;

export const TaskNotificationDataSchema = obj(
  {
    taskId: str({ minLength: 1 }),
    status: BackgroundTaskStatusSchema,
    command: str(),
    exitCode: opt(int()),
    error: opt(str()),
    cancelReason: opt(TaskCancelReasonSchema),
  },
  { open: true },
);
export type TaskNotificationData = Static<typeof TaskNotificationDataSchema>;

export function parseOptionalWithSchema<S extends Schema>(
  schema: S,
  raw: unknown,
): Static<S> | undefined {
  const result = validateWithSchema(schema, raw);
  return result.ok ? result.value : undefined;
}

export function parseLiveDocPayload(raw: unknown): LiveDocPayload | undefined {
  return parseOptionalWithSchema(LiveDocPayloadSchema, raw);
}

export function parseInboxDocPayload(raw: unknown): InboxDocPayload | undefined {
  return parseOptionalWithSchema(InboxDocPayloadSchema, raw);
}

export function parseAgentDocPayload(raw: unknown): AgentDocPayload | undefined {
  return parseOptionalWithSchema(AgentDocPayloadSchema, raw);
}

export function parseNoticeData(raw: unknown): NoticeData | undefined {
  return parseOptionalWithSchema(NoticeDataSchema, raw);
}

export function parseTaskNotificationData(raw: unknown): TaskNotificationData | undefined {
  return parseOptionalWithSchema(TaskNotificationDataSchema, raw);
}
