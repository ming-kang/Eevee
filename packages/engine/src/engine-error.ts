import { ConversationBusy, StorageRequestError } from "@earendil-works/pi-durable";
import type { Schema, Static } from "@earendil-works/pi-schema";
import { ModelsConfigError } from "@eevee/agent/models";
import { ProjectError, type ProjectErrorCode } from "@eevee/core";
import {
  formatValidationErrors,
  type Problem,
  SchemaValidationError,
  validateWithSchema,
} from "@eevee/protocol";

export class StoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreValidationError";
  }
}

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
  if (error instanceof StoreValidationError) {
    return new EngineError(400, "invalid_request", error.message);
  }
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
  if (error instanceof SchemaValidationError) {
    return new EngineError(400, "invalid_request", error.message);
  }
  if (error instanceof RangeError) {
    return new EngineError(400, "invalid_request", error.message);
  }
  return error;
}

export function parseQueryParams<S extends Schema>(schema: S, value: unknown): Static<S> {
  const checked = validateWithSchema(schema, value);
  if (!checked.ok) {
    throw new EngineError(
      400,
      "invalid_query",
      `Invalid query parameters: ${formatValidationErrors(checked.errors)}`,
    );
  }
  return checked.value;
}

export function guardSync<TArgs extends readonly unknown[], TResult>(
  assertOpen: () => void,
  fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args) => {
    assertOpen();
    return fn(...args);
  };
}

export function guardAsync<TArgs extends readonly unknown[], TResult>(
  assertOpen: () => void,
  fn: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args) => {
    assertOpen();
    return fn(...args);
  };
}
