export type TicketId = `t${number}`;
export type QuestionId = `q${number}`;
export type JobId = `j${number}`;

export const ticketId = (n: number): TicketId => `t${n}`;
export const questionId = (n: number): QuestionId => `q${n}`;
export const jobId = (n: number): JobId => `j${n}`;

export const ROLE_NAMES = ["router", "worker", "dreamer"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];
export type TicketRole = Exclude<RoleName, "router">;

/** How hard a model thinks before it answers, least to most; providers clamp to what a model supports. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ModelChoice = {
  provider: string;
  modelId: string;
  /** Unset is `off`. */
  thinkingLevel?: ThinkingLevel;
};

export type ModelDefaults = Partial<Record<"default" | RoleName, ModelChoice>>;

export function pickModel(
  role: RoleName,
  ...layers: (ModelDefaults | undefined)[]
): ModelChoice | undefined {
  for (const layer of layers) {
    const choice = layer?.[role] ?? layer?.default;
    if (choice !== undefined) return choice;
  }
  return undefined;
}

export const formatModel = (model: ModelChoice): string => `${model.provider}/${model.modelId}`;

/** The agent fields a choice sets: the model by name and its thinking level, `null` clearing a stored one. */
export const agentModel = (choice: ModelChoice) => ({
  model: { provider: choice.provider, modelId: choice.modelId },
  thinkingLevel: choice.thinkingLevel ?? null,
});

export type TicketStatus = "open" | "done" | "cancelled";

export type Ticket = {
  id: TicketId;
  role: TicketRole;
  title: string;
  goal: string;
  inputs: string[];
  acceptance: string[];
  output?: string;
  deliverTo: TicketId[];
  model?: ModelChoice;
  modelReason?: string;
  conversationId: number;
  status: TicketStatus;
  closeNote?: string;
  createdAt: number;
  closedAt?: number;
};

export type ReportStatus = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";

export const FINAL_REPORT_STATUSES = [
  "waiting",
  "ready",
  "blocked",
  "failed",
  "dropped",
] as const satisfies readonly ReportStatus[];
export type FinalReportStatus = (typeof FINAL_REPORT_STATUSES)[number];

export const isFinalReport = (status: ReportStatus): status is FinalReportStatus =>
  status !== "progress";

export const REPORT_SUMMARY_LIMIT = 600;

export type Artifact = {
  path: string;
  note: string;
};

export type QuestionItem = {
  text: string;
  options: string[];
  recommended?: string;
};

export type Report = {
  ticketId: TicketId;
  seq: number;
  status: ReportStatus;
  summary: string;
  detail?: string;
  artifacts: Artifact[];
  need?: string;
  questions?: QuestionItem[];
  lessons?: string[];
  handled: boolean;
  reminded: boolean;
  at: number;
};

export type JobStatus = "running" | "exited" | "killed" | "interrupted";

export type Job = {
  id: JobId;
  ticketId: TicketId;
  command: string;
  status: JobStatus;
  exitCode?: number;
  error?: string;
  startedAt: number;
  endedAt?: number;
};

export type Question = {
  id: QuestionId;
  ticketId?: TicketId;
  items: QuestionItem[];
  answer?: string;
  askedAt: number;
  answeredAt?: number;
};
