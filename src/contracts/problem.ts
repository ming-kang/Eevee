import type { RoleName } from "./domain.ts";

/**
 * Why the Engine refused a request, as data: the panel words it in the reader's language, and
 * `describeProblem` gives the Engine's own words for the CLI, its log and the model. Words that are
 * someone else's (a thrown error nobody expected) travel verbatim as `internal`'s `detail`.
 */
export type Problem =
  | { code: "unauthorized" }
  | { code: "bad_code" }
  | { code: "forbidden_host" }
  | { code: "no_route"; method: string; path: string }
  | { code: "no_file" }
  | { code: "bad_json" }
  | { code: "too_large" }
  | { code: "required"; field: string }
  | { code: "invalid"; field: string; allowed?: readonly string[] }
  | { code: "no_project"; projectId: string }
  | { code: "no_ticket"; ticketId: string }
  | { code: "no_worker"; ticketId: string }
  | { code: "no_question"; questionId: string }
  | { code: "no_job"; jobId: string }
  | { code: "no_memory_file"; file: string }
  | { code: "no_commit"; commit: string }
  | { code: "no_model"; provider: string; modelId: string }
  | { code: "no_provider"; provider: string }
  | { code: "no_extension"; names: readonly string[] }
  | { code: "model_unset"; role: RoleName }
  | { code: "ticket_closed"; ticketId: string }
  | { code: "report_changed"; ticketId: string }
  | { code: "answered"; questionId: string }
  | { code: "job_ended"; jobId: string }
  | { code: "running" }
  | { code: "not_failed" }
  | { code: "revert_failed"; commit: string }
  | { code: "bad_config"; problems: readonly ConfigProblem[] }
  | { code: "model_in_use"; provider: string; modelId: string }
  | { code: "probe_failed"; detail: string }
  | { code: "internal"; detail: string };

export type ProblemCode = Problem["code"];

/** An error carrying a Problem; its message is the Engine's wording. */
export class ProblemError extends Error {
  override name = "ProblemError";
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(describeProblem(problem));
    this.problem = problem;
  }
}

/** The Problem behind any thrown value; one the Engine didn't anticipate is `internal`. */
export function problemOf(error: unknown): Problem {
  if (error instanceof ProblemError) return error.problem;
  return { code: "internal", detail: error instanceof Error ? error.message : String(error) };
}

export function describeProblem(problem: Problem): string {
  switch (problem.code) {
    case "unauthorized":
      return "Not authorized: run eevee to open the panel";
    case "bad_code":
      return "The authorization code is invalid or expired; run eevee again";
    case "forbidden_host":
      return "Only requests from this machine are accepted";
    case "no_route":
      return `No endpoint ${problem.method} ${problem.path}`;
    case "no_file":
      return "No such file";
    case "bad_json":
      return "The request body is not valid JSON";
    case "too_large":
      return "The request body is too large";
    case "required":
      return `${problem.field} cannot be empty`;
    case "invalid":
      return problem.allowed === undefined
        ? `${problem.field} is not valid`
        : `${problem.field} must be one of ${problem.allowed.join(" / ")}`;
    case "no_project":
      return `No project ${problem.projectId}`;
    case "no_ticket":
      return `No ticket ${problem.ticketId}`;
    case "no_worker":
      return `No worker conversation for ${problem.ticketId}`;
    case "no_question":
      return `No question ${problem.questionId}`;
    case "no_job":
      return `No job ${problem.jobId}`;
    case "no_memory_file":
      return `No memory file ${problem.file}`;
    case "no_commit":
      return `No commit ${problem.commit}`;
    case "no_model":
      return `No model ${problem.provider}/${problem.modelId}`;
    case "no_provider":
      return `No provider ${problem.provider}`;
    case "no_extension":
      return `Extensions not installed: ${problem.names.join(", ")}`;
    case "model_unset":
      return `${problem.role} has no model: set default or ${problem.role} under models in settings.json, or name a provider and modelId when creating the ticket.`;
    case "ticket_closed":
      return `${problem.ticketId} is already closed`;
    case "report_changed":
      return `The report ${problem.ticketId} is waiting on has changed; read the latest one first`;
    case "answered":
      return `${problem.questionId} was already answered`;
    case "job_ended":
      return `Job ${problem.jobId} has already ended`;
    case "running":
      return "The conversation is running";
    case "not_failed":
      return "The last turn did not fail; there is nothing to retry";
    case "revert_failed":
      return `Could not revert ${problem.commit}: no such commit, or later changes (including uncommitted ones) conflict with it.`;
    case "bad_config":
      return problem.problems.map(describeConfigProblem).join("\n");
    case "model_in_use":
      return `${problem.provider}/${problem.modelId} is in use as the default model; change that first`;
    case "probe_failed":
      return `Could not list the models: ${problem.detail}`;
    case "internal":
      return problem.detail;
  }
}

/**
 * What is wrong with a file the user edits, or with something loaded from it. Eevee skips what it names
 * and loads the rest; a validator's or a library's own words travel verbatim as `detail`.
 */
export type ConfigIssue =
  | { code: "schema"; path: string; detail: string }
  | { code: "shape"; expected: string }
  | { code: "invalid"; field: string; allowed?: readonly string[] }
  | { code: "needs_models" }
  | { code: "unsupported_api"; model: string; api: string }
  | { code: "needs_api"; model: string }
  | { code: "needs_base_url"; model: string }
  | { code: "no_auth" }
  | { code: "env_unset"; name: string }
  | { code: "name_taken"; name: string }
  | { code: "name_reserved"; name: string }
  | { code: "bad_export" }
  | { code: "disconnected" }
  | { code: "failed"; detail: string };

/** A ConfigIssue and where it is: the file, and the provider, server or path inside it. */
export type ConfigProblem = ConfigIssue & { file: string; entry?: string };

export function describeConfigIssue(issue: ConfigIssue): string {
  switch (issue.code) {
    case "schema":
      return `${issue.path}: ${issue.detail}`;
    case "shape":
      return `Expected ${issue.expected}`;
    case "invalid":
      return issue.allowed === undefined
        ? `${issue.field} is not valid`
        : `${issue.field} must be one of ${issue.allowed.join(" / ")}`;
    case "needs_models":
      return "A new provider needs models";
    case "unsupported_api":
      return `Model ${issue.model}: api “${issue.api}” is not supported`;
    case "needs_api":
      return `Model ${issue.model} does not name an api`;
    case "needs_base_url":
      return `Model ${issue.model} has no baseUrl`;
    case "no_auth":
      return "No way to authenticate";
    case "env_unset":
      return `${issue.name} refers to an environment variable that is not set`;
    case "name_taken":
      return `Extension name ${issue.name} is already used by another file`;
    case "name_reserved":
      return `Extension name ${issue.name} is reserved by Eevee`;
    case "bad_export":
      return "The default export should be an extension (an object with a name), or a function returning one";
    case "disconnected":
      return "Disconnected";
    case "failed":
      return issue.detail;
  }
}

export function describeConfigProblem(problem: ConfigProblem): string {
  const where = problem.entry === undefined ? problem.file : `${problem.file} · ${problem.entry}`;
  return `${where}：${describeConfigIssue(problem)}`;
}
