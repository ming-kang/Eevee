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
