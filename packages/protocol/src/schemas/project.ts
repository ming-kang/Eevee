import {
  arr,
  bool,
  int,
  lit,
  map,
  nullable,
  num,
  obj,
  opt,
  type Static,
  str,
} from "@earendil-works/pi-schema";
import {
  BackgroundTaskStatusSchema,
  ModelChoiceSchema,
  ModelSlotsOverrideSchema,
  ProjectIdSchema,
  QuestionIdSchema,
  SubmissionStatusSchema,
  TaskCancelReasonSchema,
  TaskShellSchema,
  TicketIdSchema,
  TicketStatusSchema,
  ToolsSettingsSchema,
  WhenBusySchema,
  WorkerIdSchema,
  WorkerStatusSchema,
} from "./common.ts";

export * from "./conversation.ts";

export const ProjectSummarySchema = obj({
  id: ProjectIdSchema,
  title: str({ minLength: 1 }),
  workspaces: arr(str({ minLength: 1 }), { minItems: 1 }),
  memory: opt(str()),
  models: opt(ModelSlotsOverrideSchema),
  tools: opt(ToolsSettingsSchema),
  createdAt: num({ minimum: 0 }),
  updatedAt: num({ minimum: 0 }),
});
export type ProjectSummary = Static<typeof ProjectSummarySchema>;

export const CreateProjectRequestSchema = obj({
  title: opt(str({ minLength: 1 })),
  workspaces: arr(str({ minLength: 1 }), { minItems: 1 }),
  memory: opt(str()),
  models: opt(ModelSlotsOverrideSchema),
  tools: opt(ToolsSettingsSchema),
});
export type CreateProjectRequest = Static<typeof CreateProjectRequestSchema>;

export const CreateProjectResponseSchema = obj({ project: ProjectSummarySchema });
export type CreateProjectResponse = Static<typeof CreateProjectResponseSchema>;

export const ListProjectsResponseSchema = obj({ projects: arr(ProjectSummarySchema) });
export type ListProjectsResponse = Static<typeof ListProjectsResponseSchema>;

export const GetProjectResponseSchema = obj({ project: ProjectSummarySchema });
export type GetProjectResponse = Static<typeof GetProjectResponseSchema>;

export const UpdateProjectRequestSchema = obj({
  title: opt(str({ minLength: 1 })),
  workspaces: opt(arr(str({ minLength: 1 }), { minItems: 1 })),
  memory: opt(nullable(str())),
  models: opt(nullable(ModelSlotsOverrideSchema)),
  tools: opt(nullable(ToolsSettingsSchema)),
  merge: opt(bool()),
});
export type UpdateProjectRequest = Static<typeof UpdateProjectRequestSchema>;

export const DeleteProjectResponseSchema = obj({ ok: lit(true), id: ProjectIdSchema });
export type DeleteProjectResponse = Static<typeof DeleteProjectResponseSchema>;

export const ProjectMemoryResponseSchema = obj({
  projectId: ProjectIdSchema,
  memory: nullable(str()),
});
export type ProjectMemoryResponse = Static<typeof ProjectMemoryResponseSchema>;

export const PutProjectMemoryRequestSchema = obj({ memory: nullable(str()) });
export type PutProjectMemoryRequest = Static<typeof PutProjectMemoryRequestSchema>;

export const UsageCostSchema = obj({
  input: num({ minimum: 0 }),
  output: num({ minimum: 0 }),
  cacheRead: num({ minimum: 0 }),
  cacheWrite: num({ minimum: 0 }),
  total: num({ minimum: 0 }),
  totalFromProvider: opt(bool()),
});
export type UsageCostPayload = Static<typeof UsageCostSchema>;

export const UsageMetricsSchema = obj({
  input: num({ minimum: 0 }),
  output: num({ minimum: 0 }),
  cacheRead: num({ minimum: 0 }),
  cacheWrite: num({ minimum: 0 }),
  cacheWrite1h: opt(num({ minimum: 0 })),
  reasoning: opt(num({ minimum: 0 })),
  totalTokens: num({ minimum: 0 }),
  cost: UsageCostSchema,
});
export type UsageMetricsPayload = Static<typeof UsageMetricsSchema>;

export const UsageStateSchema = obj({
  models: map(UsageMetricsSchema),
  tools: map(UsageMetricsSchema),
});
export type UsageStatePayload = Static<typeof UsageStateSchema>;

export const ProjectUsageResponseSchema = obj({
  projectId: ProjectIdSchema,
  usage: UsageStateSchema,
});
export type ProjectUsageResponse = Static<typeof ProjectUsageResponseSchema>;

export const SendMessageRequestSchema = obj({
  text: str({ minLength: 1 }),
  whenBusy: opt(WhenBusySchema),
});
export type SendMessageRequest = Static<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = obj({
  submissionId: int({ minimum: 1 }),
  status: SubmissionStatusSchema,
});
export type SendMessageResponse = Static<typeof SendMessageResponseSchema>;

const BACKGROUND_TASK_RECORD_PROPERTIES = {
  id: str({ minLength: 1 }),
  durableTaskId: opt(int({ minimum: 1 })),
  shell: opt(TaskShellSchema),
  command: str(),
  cwd: opt(str()),
  status: BackgroundTaskStatusSchema,
  exitCode: opt(int()),
  error: opt(str()),
  logPath: opt(str()),
  logTruncated: opt(bool()),
  logError: opt(str()),
  cancelReason: opt(TaskCancelReasonSchema),
  startedAt: num(),
  endedAt: opt(num()),
} as const;

export const BackgroundTaskRecordSchema = obj(BACKGROUND_TASK_RECORD_PROPERTIES);
export type BackgroundTaskRecordPayload = Static<typeof BackgroundTaskRecordSchema>;

export const ProjectTaskItemSchema = obj({
  ...BACKGROUND_TASK_RECORD_PROPERTIES,
  workerId: WorkerIdSchema,
});
export type ProjectTaskItemPayload = Static<typeof ProjectTaskItemSchema>;
export type ProjectTaskItem = ProjectTaskItemPayload;

export const ListProjectTasksResponseSchema = obj({ tasks: arr(ProjectTaskItemSchema) });
export type ListProjectTasksResponse = Static<typeof ListProjectTasksResponseSchema>;

export const WorkerBoardItemSchema = obj({
  id: WorkerIdSchema,
  name: str({ minLength: 1 }),
  cwd: str({ minLength: 1 }),
  conversationId: int({ minimum: 1 }),
  model: opt(ModelChoiceSchema),
  activeTicketId: opt(TicketIdSchema),
  reportedFailure: opt(int({ minimum: 1 })),
  createdAt: num(),
  closedAt: opt(num()),
  status: WorkerStatusSchema,
  activeTaskCount: int({ minimum: 0 }),
  tasks: arr(BackgroundTaskRecordSchema),
});
export type WorkerBoardItemPayload = Static<typeof WorkerBoardItemSchema>;

export const TicketRecordSchema = obj({
  id: TicketIdSchema,
  workerId: WorkerIdSchema,
  title: str({ minLength: 1 }),
  status: TicketStatusSchema,
  note: opt(str()),
  createdAt: num(),
  closedAt: opt(num()),
});
export type TicketRecordPayload = Static<typeof TicketRecordSchema>;

export const QuestionItemSchema = obj({
  question: str({ minLength: 1 }),
  options: opt(arr(str({ minLength: 1 }))),
  recommended: opt(str()),
});
export type QuestionItemPayload = Static<typeof QuestionItemSchema>;

export const QuestionRecordSchema = obj({
  id: QuestionIdSchema,
  items: arr(QuestionItemSchema),
  answers: opt(arr(str())),
  askedAt: num(),
  answeredAt: opt(num()),
  withdrawnAt: opt(num()),
});
export type QuestionRecordPayload = Static<typeof QuestionRecordSchema>;

export const BoardViewSchema = obj({
  workers: arr(WorkerBoardItemSchema),
  tickets: arr(TicketRecordSchema),
  questions: arr(QuestionRecordSchema),
});
export type BoardViewPayload = Static<typeof BoardViewSchema>;

export const AllBoardsSnapshotEventSchema = obj({
  boards: map(BoardViewSchema),
});
export type AllBoardsSnapshotEvent = Static<typeof AllBoardsSnapshotEventSchema>;

export const AllBoardsUpdateEventSchema = obj({
  projectId: ProjectIdSchema,
  board: BoardViewSchema,
});
export type AllBoardsUpdateEvent = Static<typeof AllBoardsUpdateEventSchema>;

export const AllBoardsRemovedEventSchema = obj({
  projectId: ProjectIdSchema,
});
export type AllBoardsRemovedEvent = Static<typeof AllBoardsRemovedEventSchema>;

export const AnswerQuestionRequestSchema = obj({
  answers: arr(str(), { minItems: 1 }),
});
export type AnswerQuestionRequest = Static<typeof AnswerQuestionRequestSchema>;

export const AnswerQuestionResponseSchema = obj({ question: QuestionRecordSchema });
export type AnswerQuestionResponse = Static<typeof AnswerQuestionResponseSchema>;

export const TaskOutputSliceSchema = obj({
  text: str(),
  totalBytes: int({ minimum: 0 }),
  truncated: bool(),
  fromByte: int({ minimum: 0 }),
  endByte: int({ minimum: 0 }),
  matchedLines: opt(int({ minimum: 0 })),
  totalMatchedLines: opt(int({ minimum: 0 })),
  scanTruncated: opt(bool()),
});
export type TaskOutputSlice = Static<typeof TaskOutputSliceSchema>;
export const OutputSliceSchema = TaskOutputSliceSchema;
export type OutputSlice = TaskOutputSlice;

export const ListWorkerTasksResponseSchema = obj({ tasks: arr(BackgroundTaskRecordSchema) });
export type ListWorkerTasksResponse = Static<typeof ListWorkerTasksResponseSchema>;

export const ReadWorkerTaskResponseSchema = obj({
  task: BackgroundTaskRecordSchema,
  output: TaskOutputSliceSchema,
});
export type ReadWorkerTaskResponse = Static<typeof ReadWorkerTaskResponseSchema>;

export const KillWorkerTaskResponseSchema = obj({ task: BackgroundTaskRecordSchema });
export type KillWorkerTaskResponse = Static<typeof KillWorkerTaskResponseSchema>;

export const TaskStreamSnapshotEventSchema = obj({
  task: BackgroundTaskRecordSchema,
  output: OutputSliceSchema,
});
export type TaskStreamSnapshotEvent = Static<typeof TaskStreamSnapshotEventSchema>;

export const TaskStreamChunkEventSchema = obj({
  text: str(),
  fromByte: int({ minimum: 0 }),
  endByte: int({ minimum: 0 }),
  totalBytes: int({ minimum: 0 }),
});
export type TaskStreamChunkEvent = Static<typeof TaskStreamChunkEventSchema>;

export const TaskStreamStatusEventSchema = obj({ task: BackgroundTaskRecordSchema });
export type TaskStreamStatusEvent = Static<typeof TaskStreamStatusEventSchema>;
