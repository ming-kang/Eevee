import {
  arr,
  bool,
  compile,
  int,
  lit,
  map,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  type ParseResult,
  type Schema,
  type Static,
  str,
  union,
  unknown,
  type ValidationError,
  Validator,
} from "@earendil-works/pi-schema";

export const PROTOCOL_VERSION = 1;

export const ProjectIdSchema = str({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$" });
export const WorkerIdSchema = str({ pattern: "^w[1-9][0-9]*$" });
export const TicketIdSchema = str({ pattern: "^t[1-9][0-9]*$" });
export const QuestionIdSchema = str({ pattern: "^q[1-9][0-9]*$" });
export const ConversationRefSchema = union([lit("router"), WorkerIdSchema]);

export const WorkerStatusSchema = oneOf(["queued", "running", "idle", "closed"]);
export const TicketStatusSchema = oneOf(["open", "done", "cancelled"]);
export const BackgroundTaskStatusSchema = oneOf([
  "queued",
  "running",
  "stopping",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
]);
export const TaskShellSchema = oneOf(["bash", "powershell"]);
export const TaskCancelReasonSchema = oneOf(["user", "tool", "abort"]);
export const TaskListStatusFilterSchema = oneOf(["all", "active", "finished"]);
export const ThinkingLevelSchema = oneOf([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const WhenBusySchema = oneOf(["steer", "followUp", "reject"]);
export const SubmissionStatusSchema = oneOf(["queued", "placed", "done", "unanswered"]);

export const ModelChoiceSchema = obj({
  provider: str({ minLength: 1 }),
  modelId: str({ minLength: 1 }),
  thinkingLevel: opt(ThinkingLevelSchema),
});

export const ModelSlotsOverrideSchema = obj({
  router: opt(ModelChoiceSchema),
  worker: opt(ModelChoiceSchema),
  dreamer: opt(ModelChoiceSchema),
});

export const CodemodeModeSchema = oneOf(["off", "on", "only"]);
export const CodemodeSettingsSchema = obj({
  mode: opt(CodemodeModeSchema),
  inlineBudget: opt(int({ minimum: 0 })),
});
export const ToolsSettingsSchema = obj({
  router: opt(map(bool())),
  worker: opt(map(bool())),
  codemode: opt(CodemodeSettingsSchema),
});

export const ROUTER_TOGGLEABLE_TOOLS = ["read", "ls", "find", "grep", "tool_search"] as const;
export const WORKER_TOGGLEABLE_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "tasks",
  "ls",
  "find",
  "grep",
  "tool_search",
] as const;
export const WORKER_DEFAULT_DISABLED_TOOLS = ["powershell", "ls", "find", "grep"] as const;

export const ProblemSchema = obj({
  code: str({ minLength: 1 }),
  message: str({ minLength: 1 }),
  detail: opt(str()),
});

export const HealthResponseSchema = obj({
  ok: lit(true),
  protocolVersion: int({ minimum: 1 }),
  engineVersion: str({ minLength: 1 }),
  pid: opt(int({ minimum: 1 })),
});

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

export const CreateProjectRequestSchema = obj({
  title: opt(str({ minLength: 1 })),
  workspaces: arr(str({ minLength: 1 }), { minItems: 1 }),
  memory: opt(str()),
  models: opt(ModelSlotsOverrideSchema),
  tools: opt(ToolsSettingsSchema),
});

export const CreateProjectResponseSchema = obj({
  project: ProjectSummarySchema,
});

export const ListProjectsResponseSchema = obj({
  projects: arr(ProjectSummarySchema),
});

export const GetProjectResponseSchema = obj({
  project: ProjectSummarySchema,
});

export const SendMessageRequestSchema = obj({
  text: str({ minLength: 1 }),
  whenBusy: opt(WhenBusySchema),
});

export const SendMessageResponseSchema = obj({
  submissionId: int({ minimum: 1 }),
  status: SubmissionStatusSchema,
});

export const BackgroundTaskRecordSchema = obj({
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
});

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

export const TicketRecordSchema = obj({
  id: TicketIdSchema,
  workerId: WorkerIdSchema,
  title: str({ minLength: 1 }),
  status: TicketStatusSchema,
  note: opt(str()),
  createdAt: num(),
  closedAt: opt(num()),
});

export const QuestionItemSchema = obj({
  question: str({ minLength: 1 }),
  options: opt(arr(str({ minLength: 1 }))),
  recommended: opt(str()),
});

export const QuestionRecordSchema = obj({
  id: QuestionIdSchema,
  items: arr(QuestionItemSchema),
  answers: opt(arr(str())),
  askedAt: num(),
  answeredAt: opt(num()),
  withdrawnAt: opt(num()),
});

export const BoardViewSchema = obj({
  workers: arr(WorkerBoardItemSchema),
  tickets: arr(TicketRecordSchema),
  questions: arr(QuestionRecordSchema),
});

export const ConversationRecordSchema = obj(
  {
    id: int({ minimum: 1 }),
    parent: opt(obj({ conversationId: int({ minimum: 1 }), at: int({ minimum: 1 }) })),
    owner: opt(obj({ conversationId: int({ minimum: 1 }), taskId: int({ minimum: 1 }) })),
  },
  { open: true },
);

export const EntryModelMessageSchema = obj(
  {
    role: str({ minLength: 1 }),
    content: opt(unknown()),
    toolName: opt(str()),
    isError: opt(bool()),
    stopReason: opt(str()),
    errorMessage: opt(str()),
  },
  { open: true },
);

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

export const ConversationViewPayloadSchema = obj({
  conversation: ConversationRecordSchema,
  entries: arr(EntryRecordSchema),
  before: opt(int({ minimum: 1 })),
  docs: map(obj({}, { open: true })),
});

export const ConversationSnapshotEventSchema = obj({
  view: ConversationViewPayloadSchema,
});

export const ConversationPatchEventSchema = obj({
  ops: arr(unknown()),
  retired: bool(),
});

export const ConversationFailedEventSchema = obj({
  message: str({ minLength: 1 }),
});

export const StreamEndEventSchema = obj({
  reason: oneOf(["ended", "aborted", "closed", "failed", "terminal", "completed"]),
  message: opt(str()),
});

export const ScanOrderSchema = oneOf(["ascending", "descending"]);

export const ListEntriesResponseSchema = obj({
  entries: arr(EntryRecordSchema),
  nextCursor: opt(str({ minLength: 1 })),
});

export const OkResponseSchema = obj({
  ok: lit(true),
});

export const AnswerQuestionRequestSchema = obj({
  answers: arr(str(), { minItems: 1 }),
});

export const AnswerQuestionResponseSchema = obj({
  question: QuestionRecordSchema,
});

export const TaskReadModeSchema = oneOf(["head", "tail"]);

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

export const OutputSliceSchema = TaskOutputSliceSchema;

export const ListWorkerTasksResponseSchema = obj({
  tasks: arr(BackgroundTaskRecordSchema),
});

export const ReadWorkerTaskResponseSchema = obj({
  task: BackgroundTaskRecordSchema,
  output: TaskOutputSliceSchema,
});

export const KillWorkerTaskResponseSchema = obj({
  task: BackgroundTaskRecordSchema,
});

export const TaskStreamSnapshotEventSchema = obj({
  task: BackgroundTaskRecordSchema,
  output: OutputSliceSchema,
});

export const TaskStreamChunkEventSchema = obj({
  text: str(),
  fromByte: int({ minimum: 0 }),
  endByte: int({ minimum: 0 }),
  totalBytes: int({ minimum: 0 }),
});

export const TaskStreamStatusEventSchema = obj({
  task: BackgroundTaskRecordSchema,
});

export const AuthTypeSchema = oneOf(["api_key", "oauth"]);

export const ProviderAuthMethodsSchema = obj({
  apiKey: bool(),
  apiKeyLogin: bool(),
  oauth: bool(),
  oauthName: opt(str()),
  oauthLabel: opt(str()),
});

export const ProviderSummarySchema = obj({
  id: str({ minLength: 1 }),
  name: str({ minLength: 1 }),
  baseUrl: opt(str()),
  authMethods: ProviderAuthMethodsSchema,
  configured: bool(),
  authType: opt(AuthTypeSchema),
  authSource: opt(str()),
  modelCount: int({ minimum: 0 }),
});

export const ListProvidersResponseSchema = obj({
  providers: arr(ProviderSummarySchema),
});

export const SetApiKeyRequestSchema = obj({
  key: opt(str()),
  env: opt(map(str())),
});

export const StartLoginRequestSchema = obj({
  type: AuthTypeSchema,
});

export const StartLoginResponseSchema = obj({
  sessionId: str({ minLength: 1 }),
  providerId: str({ minLength: 1 }),
  type: AuthTypeSchema,
});

export const LoginInputRequestSchema = obj({
  promptId: str({ minLength: 1 }),
  value: str(),
});

export const LoginAuthInfoLinkSchema = obj({
  url: str(),
  label: opt(str()),
});

export const LoginAuthEventSchema = union([
  obj({
    type: lit("info"),
    message: str(),
    links: opt(arr(LoginAuthInfoLinkSchema)),
  }),
  obj({
    type: lit("auth_url"),
    url: str(),
    instructions: opt(str()),
  }),
  obj({
    type: lit("device_code"),
    userCode: str(),
    verificationUri: str(),
    openBrowserOnConfirm: opt(bool()),
    copyCodeOnConfirm: opt(bool()),
    intervalSeconds: opt(num()),
    expiresInSeconds: opt(num()),
  }),
  obj({
    type: lit("progress"),
    message: str(),
  }),
]);

export const LoginPromptOptionSchema = obj({
  id: str(),
  label: str(),
  description: opt(str()),
});

export const LoginPromptEventSchema = union([
  obj({
    promptId: str({ minLength: 1 }),
    type: lit("text"),
    message: str(),
    placeholder: opt(str()),
  }),
  obj({
    promptId: str({ minLength: 1 }),
    type: lit("secret"),
    message: str(),
    placeholder: opt(str()),
  }),
  obj({
    promptId: str({ minLength: 1 }),
    type: lit("select"),
    message: str(),
    options: arr(LoginPromptOptionSchema),
  }),
  obj({
    promptId: str({ minLength: 1 }),
    type: lit("manual_code"),
    message: str(),
    placeholder: opt(str()),
  }),
]);

export const LoginCompleteEventSchema = obj({
  providerId: str({ minLength: 1 }),
  type: AuthTypeSchema,
});

export const LoginErrorEventSchema = obj({
  code: str({ minLength: 1 }),
  message: str({ minLength: 1 }),
});

export const ModelCostTierSchema = obj({
  input: num(),
  output: num(),
  cacheRead: num(),
  cacheWrite: num(),
  inputTokensAbove: num(),
});

export const ModelCostSchema = obj({
  input: num(),
  output: num(),
  cacheRead: num(),
  cacheWrite: num(),
  tiers: opt(arr(ModelCostTierSchema)),
});

export const ModelInfoSchema = obj({
  provider: str({ minLength: 1 }),
  id: str({ minLength: 1 }),
  name: str({ minLength: 1 }),
  api: str({ minLength: 1 }),
  reasoning: bool(),
  contextWindow: num({ minimum: 0 }),
  maxTokens: num({ minimum: 0 }),
  cost: ModelCostSchema,
  available: bool(),
});

export const ListModelsResponseSchema = obj({
  models: arr(ModelInfoSchema),
});

export const RefreshModelsRequestSchema = obj({
  providers: opt(arr(str({ minLength: 1 }))),
  force: opt(bool()),
});

export const RefreshModelsResponseSchema = obj({
  refreshed: lit(true),
  errors: map(str()),
});

export const ModelProfileSchema = obj({
  id: str({ minLength: 1 }),
  model: ModelChoiceSchema,
  description: str({ minLength: 1 }),
});

export const ModelProfilesDocumentSchema = obj({
  profiles: arr(ModelProfileSchema),
  notes: opt(str()),
});

export const McpServerStatusSchema = oneOf([
  "idle",
  "connecting",
  "connected",
  "disconnected",
  "failed",
  "closed",
]);

export const McpServerSnapshotSchema = obj({
  name: str({ minLength: 1 }),
  status: McpServerStatusSchema,
  enabled: bool(),
  description: opt(str()),
  instructions: opt(str()),
  toolCount: int({ minimum: 0 }),
  error: opt(str()),
});

export const McpStateResponseSchema = obj({
  servers: map(obj({}, { open: true })),
  status: arr(McpServerSnapshotSchema),
});

export const PutMcpConfigRequestSchema = obj({
  servers: map(obj({}, { open: true })),
});

export const UpsertMcpServerRequestSchema = obj({
  config: obj({}, { open: true }),
});

export const ReconnectMcpRequestSchema = obj({
  server: opt(str({ minLength: 1 })),
});

export const ReconnectMcpResponseSchema = obj({
  status: arr(McpServerSnapshotSchema),
});

export const EngineSettingsSchema = obj({
  maxActiveWorkers: opt(int({ minimum: 0 })),
  backgroundAfterMs: opt(int({ minimum: 0 })),
  routerContextTokens: opt(int({ minimum: 1 })),
  idleHibernateMs: opt(int({ minimum: 0 })),
  models: opt(ModelSlotsOverrideSchema),
  tools: opt(ToolsSettingsSchema),
});

export const ConfigBundleSchema = obj({
  version: lit(1),
  settings: EngineSettingsSchema,
  modelProfiles: ModelProfilesDocumentSchema,
  mcpServers: map(obj({}, { open: true })),
  modelsConfig: opt(obj({}, { open: true })),
});

export const UpdateProjectRequestSchema = obj({
  title: opt(str({ minLength: 1 })),
  workspaces: opt(arr(str({ minLength: 1 }), { minItems: 1 })),
  memory: opt(nullable(str())),
  models: opt(nullable(ModelSlotsOverrideSchema)),
  tools: opt(nullable(ToolsSettingsSchema)),
});

export const DeleteProjectResponseSchema = obj({
  ok: lit(true),
  id: ProjectIdSchema,
});

export const ProjectMemoryResponseSchema = obj({
  projectId: ProjectIdSchema,
  memory: nullable(str()),
});

export const PutProjectMemoryRequestSchema = obj({
  memory: nullable(str()),
});

export const UsageCostSchema = obj({
  input: num({ minimum: 0 }),
  output: num({ minimum: 0 }),
  cacheRead: num({ minimum: 0 }),
  cacheWrite: num({ minimum: 0 }),
  total: num({ minimum: 0 }),
  totalFromProvider: opt(bool()),
});

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

export const UsageStateSchema = obj({
  models: map(UsageMetricsSchema),
  tools: map(UsageMetricsSchema),
});

export const ProjectUsageResponseSchema = obj({
  projectId: ProjectIdSchema,
  usage: UsageStateSchema,
});

export type ProjectId = Static<typeof ProjectIdSchema>;
export type WorkerId = Static<typeof WorkerIdSchema>;
export type TicketId = Static<typeof TicketIdSchema>;
export type QuestionId = Static<typeof QuestionIdSchema>;
export type ConversationRef = Static<typeof ConversationRefSchema>;
export type WorkerStatus = Static<typeof WorkerStatusSchema>;
export type TicketStatus = Static<typeof TicketStatusSchema>;
export type BackgroundTaskStatus = Static<typeof BackgroundTaskStatusSchema>;
export type TaskShell = Static<typeof TaskShellSchema>;
export type TaskCancelReason = Static<typeof TaskCancelReasonSchema>;
export type TaskListStatusFilter = Static<typeof TaskListStatusFilterSchema>;
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type WhenBusy = Static<typeof WhenBusySchema>;
export type SubmissionStatus = Static<typeof SubmissionStatusSchema>;
export type ModelChoice = Static<typeof ModelChoiceSchema>;
export type ModelSlotsOverride = Static<typeof ModelSlotsOverrideSchema>;
export type CodemodeMode = Static<typeof CodemodeModeSchema>;
export type CodemodeSettings = Static<typeof CodemodeSettingsSchema>;
export type ToolsSettings = Static<typeof ToolsSettingsSchema>;
export type Problem = Static<typeof ProblemSchema>;
export type HealthResponse = Static<typeof HealthResponseSchema>;
export type ProjectSummary = Static<typeof ProjectSummarySchema>;
export type CreateProjectRequest = Static<typeof CreateProjectRequestSchema>;
export type CreateProjectResponse = Static<typeof CreateProjectResponseSchema>;
export type ListProjectsResponse = Static<typeof ListProjectsResponseSchema>;
export type GetProjectResponse = Static<typeof GetProjectResponseSchema>;
export type SendMessageRequest = Static<typeof SendMessageRequestSchema>;
export type SendMessageResponse = Static<typeof SendMessageResponseSchema>;
export type BackgroundTaskRecordPayload = Static<typeof BackgroundTaskRecordSchema>;
export type WorkerBoardItemPayload = Static<typeof WorkerBoardItemSchema>;
export type TicketRecordPayload = Static<typeof TicketRecordSchema>;
export type QuestionItemPayload = Static<typeof QuestionItemSchema>;
export type QuestionRecordPayload = Static<typeof QuestionRecordSchema>;
export type BoardViewPayload = Static<typeof BoardViewSchema>;
export type ConversationRecordPayload = Static<typeof ConversationRecordSchema>;
export type EntryModelMessagePayload = Static<typeof EntryModelMessageSchema>;
export type EntryRecordPayload = Static<typeof EntryRecordSchema>;
export type ConversationViewPayload = Static<typeof ConversationViewPayloadSchema>;
export type ConversationSnapshotEvent = Static<typeof ConversationSnapshotEventSchema>;
export type ConversationPatchEvent = Static<typeof ConversationPatchEventSchema>;
export type ConversationFailedEvent = Static<typeof ConversationFailedEventSchema>;
export type StreamEndEvent = Static<typeof StreamEndEventSchema>;
export type ScanOrder = Static<typeof ScanOrderSchema>;
export type ListEntriesResponse = Static<typeof ListEntriesResponseSchema>;
export type OkResponse = Static<typeof OkResponseSchema>;
export type AnswerQuestionRequest = Static<typeof AnswerQuestionRequestSchema>;
export type AnswerQuestionResponse = Static<typeof AnswerQuestionResponseSchema>;
export type TaskReadMode = Static<typeof TaskReadModeSchema>;
export type TaskOutputSlice = Static<typeof TaskOutputSliceSchema>;
export type OutputSlice = TaskOutputSlice;
export type ListWorkerTasksResponse = Static<typeof ListWorkerTasksResponseSchema>;
export type ReadWorkerTaskResponse = Static<typeof ReadWorkerTaskResponseSchema>;
export type KillWorkerTaskResponse = Static<typeof KillWorkerTaskResponseSchema>;
export type TaskStreamSnapshotEvent = Static<typeof TaskStreamSnapshotEventSchema>;
export type TaskStreamChunkEvent = Static<typeof TaskStreamChunkEventSchema>;
export type TaskStreamStatusEvent = Static<typeof TaskStreamStatusEventSchema>;
export type AuthType = Static<typeof AuthTypeSchema>;
export type ProviderAuthMethods = Static<typeof ProviderAuthMethodsSchema>;
export type ProviderSummary = Static<typeof ProviderSummarySchema>;
export type ListProvidersResponse = Static<typeof ListProvidersResponseSchema>;
export type SetApiKeyRequest = Static<typeof SetApiKeyRequestSchema>;
export type StartLoginRequest = Static<typeof StartLoginRequestSchema>;
export type StartLoginResponse = Static<typeof StartLoginResponseSchema>;
export type LoginInputRequest = Static<typeof LoginInputRequestSchema>;
export type LoginAuthInfoLink = Static<typeof LoginAuthInfoLinkSchema>;
export type LoginAuthEvent = Static<typeof LoginAuthEventSchema>;
export type LoginPromptOption = Static<typeof LoginPromptOptionSchema>;
export type LoginPromptEvent = Static<typeof LoginPromptEventSchema>;
export type LoginCompleteEvent = Static<typeof LoginCompleteEventSchema>;
export type LoginErrorEvent = Static<typeof LoginErrorEventSchema>;
export type ModelCostTier = Static<typeof ModelCostTierSchema>;
export type ModelCostPayload = Static<typeof ModelCostSchema>;
export type ModelInfo = Static<typeof ModelInfoSchema>;
export type ListModelsResponse = Static<typeof ListModelsResponseSchema>;
export type RefreshModelsRequest = Static<typeof RefreshModelsRequestSchema>;
export type RefreshModelsResponse = Static<typeof RefreshModelsResponseSchema>;
export type ModelProfile = Static<typeof ModelProfileSchema>;
export type ModelProfilesDocument = Static<typeof ModelProfilesDocumentSchema>;
export type McpServerStatusPayload = Static<typeof McpServerStatusSchema>;
export type McpServerSnapshotPayload = Static<typeof McpServerSnapshotSchema>;
export type McpStateResponse = Static<typeof McpStateResponseSchema>;
export type PutMcpConfigRequest = Static<typeof PutMcpConfigRequestSchema>;
export type UpsertMcpServerRequest = Static<typeof UpsertMcpServerRequestSchema>;
export type ReconnectMcpRequest = Static<typeof ReconnectMcpRequestSchema>;
export type ReconnectMcpResponse = Static<typeof ReconnectMcpResponseSchema>;
export type EngineSettings = Static<typeof EngineSettingsSchema>;
export type ConfigBundle = Static<typeof ConfigBundleSchema>;
export type UpdateProjectRequest = Static<typeof UpdateProjectRequestSchema>;
export type DeleteProjectResponse = Static<typeof DeleteProjectResponseSchema>;
export type ProjectMemoryResponse = Static<typeof ProjectMemoryResponseSchema>;
export type PutProjectMemoryRequest = Static<typeof PutProjectMemoryRequestSchema>;
export type UsageCostPayload = Static<typeof UsageCostSchema>;
export type UsageMetricsPayload = Static<typeof UsageMetricsSchema>;
export type UsageStatePayload = Static<typeof UsageStateSchema>;
export type ProjectUsageResponse = Static<typeof ProjectUsageResponseSchema>;

export const WebSessionResponseSchema = obj({
  authenticated: bool(),
});

export type WebSessionResponse = Static<typeof WebSessionResponseSchema>;

export const CreateWebSessionRequestSchema = obj({
  token: opt(str({ minLength: 1 })),
  ticket: opt(str({ minLength: 1 })),
});

export type CreateWebSessionRequest = Static<typeof CreateWebSessionRequestSchema>;

export const CreateWebTicketResponseSchema = obj({
  ticket: str({ minLength: 1 }),
  expiresAt: num(),
});

export type CreateWebTicketResponse = Static<typeof CreateWebTicketResponseSchema>;

export function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors.map((err) => `${err.path || "<root>"}: ${err.message}`).join("; ");
}

export class SchemaValidationError extends Error {
  readonly errors: readonly ValidationError[];

  constructor(label: string, errors: readonly ValidationError[]) {
    super(`Invalid ${label}: ${formatValidationErrors(errors)}`);
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

const validatorCache = new WeakMap<object, Validator<unknown>>();

function resolveValidator<T>(schemaOrValidator: Schema<T> | Validator<T>): Validator<T> {
  if (schemaOrValidator instanceof Validator) return schemaOrValidator;
  let cached = validatorCache.get(schemaOrValidator);
  if (cached === undefined) {
    cached = compile(schemaOrValidator);
    validatorCache.set(schemaOrValidator, cached);
  }
  return cached as Validator<T>;
}

export function validateWithSchema<S extends Schema>(
  schemaOrValidator: S,
  value: unknown,
): ParseResult<Static<S>>;
export function validateWithSchema<T>(
  schemaOrValidator: Validator<T>,
  value: unknown,
): ParseResult<T>;
export function validateWithSchema<T>(
  schemaOrValidator: Schema<T> | Validator<T>,
  value: unknown,
): ParseResult<T> {
  return resolveValidator(schemaOrValidator).validate(value);
}

export function parseWithSchema<S extends Schema>(
  schemaOrValidator: S,
  value: unknown,
  label?: string,
): Static<S>;
export function parseWithSchema<T>(
  schemaOrValidator: Validator<T>,
  value: unknown,
  label?: string,
): T;
export function parseWithSchema<T>(
  schemaOrValidator: Schema<T> | Validator<T>,
  value: unknown,
  label = "payload",
): T {
  const result = resolveValidator(schemaOrValidator).validate(value);
  if (!result.ok) throw new SchemaValidationError(label, result.errors);
  return result.value;
}
