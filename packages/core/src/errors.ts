export type ProjectErrorCode =
  | "worker_not_found"
  | "worker_closed"
  | "worker_queued"
  | "question_not_found"
  | "question_closed"
  | "invalid_answer"
  | "task_not_found"
  | "task_ambiguous"
  | "task_not_running";

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;

  constructor(code: ProjectErrorCode, message: string) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
  }
}
