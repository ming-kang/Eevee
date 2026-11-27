import { ConversationBusy, StorageRequestError } from "@earendil-works/pi-durable";
import { ModelsConfigError } from "@eevee/agent/models";
import { ProjectError, type ProjectErrorCode } from "@eevee/core";
import type { Problem } from "@eevee/protocol";

export class EngineError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "EngineError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  toProblem(): Problem {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

const PROJECT_ERROR_HTTP: Record<ProjectErrorCode, readonly [status: number, code: string]> = {
  worker_not_found: [404, "worker_not_found"],
  worker_closed: [409, "worker_closed"],
  worker_queued: [409, "worker_queued"],
  question_not_found: [404, "question_not_found"],
  question_closed: [409, "question_closed"],
  invalid_answer: [400, "invalid_request"],
  task_not_found: [404, "task_not_found"],
  task_ambiguous: [400, "task_ambiguous"],
  task_not_running: [409, "task_not_running"],
};

export function toEngineError(error: unknown): unknown {
  if (error instanceof ModelsConfigError) {
    return new EngineError(400, "invalid_request", error.message);
  }
  if (error instanceof ProjectError) {
    const [status, code] = PROJECT_ERROR_HTTP[error.code];
    return new EngineError(status, code, error.message);
  }
  if (error instanceof ConversationBusy) {
    return new EngineError(409, "conversation_busy", error.message);
  }
  if (error instanceof StorageRequestError) {
    return new EngineError(400, "invalid_query", error.message);
  }
  if (error instanceof RangeError) {
    return new EngineError(400, "invalid_request", error.message);
  }
  return error;
}
