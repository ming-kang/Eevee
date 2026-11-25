import { AGENT_EXTENSIONS, type ModelChoice } from "@eevee/agent";
import { MEMORY_EXTENSION } from "@eevee/memory";

export const ROUTER_EXTENSION = "eevee.router";
export const WORKER_EXTENSION = "eevee.worker";

export const ROUTER_EXTENSIONS = [
  AGENT_EXTENSIONS.readonlyTools,
  AGENT_EXTENSIONS.shellPaths,
  AGENT_EXTENSIONS.codemode,
  AGENT_EXTENSIONS.toolSearch,
  AGENT_EXTENSIONS.mcp,
  MEMORY_EXTENSION,
  ROUTER_EXTENSION,
] as const;

export const WORKER_EXTENSIONS = [
  AGENT_EXTENSIONS.codingTools,
  AGENT_EXTENSIONS.shellPaths,
  AGENT_EXTENSIONS.tasks,
  AGENT_EXTENSIONS.codemode,
  AGENT_EXTENSIONS.toolSearch,
  AGENT_EXTENSIONS.mcp,
  AGENT_EXTENSIONS.cachedCompaction,
  WORKER_EXTENSION,
] as const;

export const ROUTER_COLLAB_TOOLS = [
  "spawn_worker",
  "message_worker",
  "close_ticket",
  "stop_worker",
  "inspect_worker",
  "ask_user",
] as const;

export const WORKER_COLLAB_TOOLS = ["message_router"] as const;

export type WorkerId = `w${number}`;
export type TicketId = `t${number}`;
export type QuestionId = `q${number}`;

export type WorkerStatus = "queued" | "running" | "idle" | "closed";
export type TicketStatus = "open" | "done" | "cancelled";

export type TicketRecord = {
  readonly id: TicketId;
  readonly workerId: WorkerId;
  readonly title: string;
  readonly prompt: string;
  readonly status: TicketStatus;
  readonly note?: string;
  readonly createdAt: number;
  readonly closedAt?: number;
};

export type WorkerRecord = {
  readonly id: WorkerId;
  readonly name: string;
  readonly cwd: string;
  readonly conversationId: number;
  readonly status: WorkerStatus;
  readonly model?: ModelChoice;
  readonly activeTicketId?: TicketId;
  readonly createdAt: number;
  readonly closedAt?: number;
};

export type QuestionItem = {
  readonly question: string;
  readonly options?: readonly string[];
  readonly recommended?: string;
};

export type QuestionRecord = {
  readonly id: QuestionId;
  readonly items: readonly QuestionItem[];
  readonly answers?: readonly string[];
  readonly askedAt: number;
  readonly answeredAt?: number;
};
