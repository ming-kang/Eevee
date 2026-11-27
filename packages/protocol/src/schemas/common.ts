import {
  bool,
  compile,
  int,
  lit,
  map,
  obj,
  oneOf,
  opt,
  type ParseResult,
  type Schema,
  type Static,
  str,
  union,
  type ValidationError,
  Validator,
} from "@earendil-works/pi-schema";

export const PROTOCOL_VERSION = 1;

export const ProjectIdSchema = str({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$" });
export type ProjectId = Static<typeof ProjectIdSchema>;

export const WorkerIdSchema = str({ pattern: "^w[1-9][0-9]*$" });
export type WorkerId = Static<typeof WorkerIdSchema>;

export const TicketIdSchema = str({ pattern: "^t[1-9][0-9]*$" });
export type TicketId = Static<typeof TicketIdSchema>;

export const QuestionIdSchema = str({ pattern: "^q[1-9][0-9]*$" });
export type QuestionId = Static<typeof QuestionIdSchema>;

export const ConversationRefSchema = union([lit("router"), WorkerIdSchema]);
export type ConversationRef = Static<typeof ConversationRefSchema>;

export const WorkerStatusSchema = oneOf(["queued", "running", "idle", "closed"]);
export type WorkerStatus = Static<typeof WorkerStatusSchema>;

export const TicketStatusSchema = oneOf(["open", "done", "cancelled"]);
export type TicketStatus = Static<typeof TicketStatusSchema>;

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
export type BackgroundTaskStatus = Static<typeof BackgroundTaskStatusSchema>;

export const TaskShellSchema = oneOf(["bash", "powershell"]);
export type TaskShell = Static<typeof TaskShellSchema>;

export const TaskCancelReasonSchema = oneOf(["user", "tool", "abort"]);
export type TaskCancelReason = Static<typeof TaskCancelReasonSchema>;

export const TaskListStatusFilterSchema = oneOf(["all", "active", "finished"]);
export type TaskListStatusFilter = Static<typeof TaskListStatusFilterSchema>;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ThinkingLevelSchema = oneOf(THINKING_LEVELS);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export const WhenBusySchema = oneOf(["steer", "followUp", "reject"]);
export type WhenBusy = Static<typeof WhenBusySchema>;

export const SubmissionStatusSchema = oneOf(["queued", "placed", "done", "unanswered"]);
export type SubmissionStatus = Static<typeof SubmissionStatusSchema>;

export const ScanOrderSchema = oneOf(["ascending", "descending"]);
export type ScanOrder = Static<typeof ScanOrderSchema>;

export const TaskReadModeSchema = oneOf(["head", "tail"]);
export type TaskReadMode = Static<typeof TaskReadModeSchema>;

export const ModelChoiceSchema = obj({
  provider: str({ minLength: 1 }),
  modelId: str({ minLength: 1 }),
  thinkingLevel: opt(ThinkingLevelSchema),
});
export type ModelChoice = Static<typeof ModelChoiceSchema>;

export const ModelSlotsOverrideSchema = obj({
  router: opt(ModelChoiceSchema),
  worker: opt(ModelChoiceSchema),
  dreamer: opt(ModelChoiceSchema),
});
export type ModelSlotsOverride = Static<typeof ModelSlotsOverrideSchema>;

export const CodemodeModeSchema = oneOf(["off", "on", "only"]);
export type CodemodeMode = Static<typeof CodemodeModeSchema>;

export const CodemodeSettingsSchema = obj({
  mode: opt(CodemodeModeSchema),
  inlineBudget: opt(int({ minimum: 0 })),
});
export type CodemodeSettings = Static<typeof CodemodeSettingsSchema>;

export const ToolsSettingsSchema = obj({
  router: opt(map(bool())),
  worker: opt(map(bool())),
  codemode: opt(CodemodeSettingsSchema),
});
export type ToolsSettings = Static<typeof ToolsSettingsSchema>;

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
export type Problem = Static<typeof ProblemSchema>;

export const HealthResponseSchema = obj({
  ok: lit(true),
  protocolVersion: int({ minimum: 1 }),
  engineVersion: str({ minLength: 1 }),
  pid: opt(int({ minimum: 1 })),
});
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const OkResponseSchema = obj({
  ok: lit(true),
});
export type OkResponse = Static<typeof OkResponseSchema>;

export const StreamEndEventSchema = obj({
  reason: oneOf(["ended", "aborted", "closed", "failed", "terminal", "completed"]),
  message: opt(str()),
});
export type StreamEndEvent = Static<typeof StreamEndEventSchema>;

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
