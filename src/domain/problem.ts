import type { RoleName } from "./domain.ts";
import { fill, type Translate } from "./text.ts";

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
  | { code: "no_dir"; path: string }
  | { code: "not_dir"; path: string }
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
  | { code: "memory_changed"; file: string }
  | { code: "memory_restricted" }
  | { code: "no_proposal"; proposalId: string }
  | { code: "proposal_decided"; proposalId: string }
  | { code: "no_change"; change: number }
  | { code: "no_submission"; submissionId: string }
  | { code: "already_delivered" }
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
  | { code: "undo_failed"; change: number }
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

export function describeProblem(problem: Problem, t: Translate = fill): string {
  switch (problem.code) {
    case "unauthorized":
      return t("Not authorized: run eevee to open the panel");
    case "bad_code":
      return t("The authorization code is invalid or expired; run eevee again");
    case "forbidden_host":
      return t("Only requests from this machine are accepted");
    case "no_route":
      return t("No endpoint {method} {path}", problem);
    case "no_file":
      return t("No such file");
    case "no_dir":
      return t("No directory {path}", problem);
    case "not_dir":
      return t("{path} is not a directory", problem);
    case "bad_json":
      return t("The request body is not valid JSON");
    case "too_large":
      return t("The request body is too large");
    case "required":
      return t("{field} cannot be empty", problem);
    case "invalid":
      return problem.allowed === undefined
        ? t("{field} is not valid", { field: problem.field })
        : t("{field} must be one of {allowed}", {
            field: problem.field,
            allowed: problem.allowed.join(" / "),
          });
    case "no_project":
      return t("No project {projectId}", problem);
    case "no_ticket":
      return t("No ticket {ticketId}", problem);
    case "no_worker":
      return t("No worker conversation for {ticketId}", problem);
    case "no_question":
      return t("No question {questionId}", problem);
    case "no_job":
      return t("No job {jobId}", problem);
    case "no_memory_file":
      return t("No memory file {file}", problem);
    case "memory_changed":
      return t("Memory file {file} changed. Reload the latest content and try again.", problem);
    case "memory_restricted":
      return t("Global memory only supports editing the existing MEMORY.md file");
    case "no_proposal":
      return t("No memory proposal {proposalId}", problem);
    case "proposal_decided":
      return t("Memory proposal {proposalId} has already been decided", problem);
    case "no_change":
      return t("No change #{change}", problem);
    case "no_submission":
      return t("That message is not in the queue any more", problem);
    case "already_delivered":
      return t("That message already reached the conversation");
    case "no_model":
      return t("No model {provider}/{modelId}", problem);
    case "no_provider":
      return t("No provider {provider}", problem);
    case "no_extension":
      return t("Extensions not installed: {names}", { names: problem.names.join(t(", ")) });
    case "model_unset":
      return t(
        "{role} has no model. Under models in settings.json, set a default or the {role} model. You can also name a provider and modelId when you create the ticket.",
        problem,
      );
    case "ticket_closed":
      return t("{ticketId} is already closed", problem);
    case "report_changed":
      return t(
        "The report {ticketId} is waiting on has changed; read the latest one first",
        problem,
      );
    case "answered":
      return t("{questionId} was already answered", problem);
    case "job_ended":
      return t("Job {jobId} has already ended", problem);
    case "running":
      return t("The conversation is running");
    case "not_failed":
      return t("The last turn did not fail; there is nothing to retry");
    case "undo_failed":
      return t("Could not undo change #{change}: later changes conflict with it", problem);
    case "bad_config":
      return problem.problems.map((p) => describeConfigProblem(p, t)).join("\n");
    case "model_in_use":
      return t("{provider}/{modelId} is in use as the default model; change that first", problem);
    case "probe_failed":
      return t("Could not list the models: {detail}", problem);
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
  | { code: "disconnected" }
  | { code: "failed"; detail: string };

export type ConfigProblem = ConfigIssue & { file: string; entry?: string };

export function describeConfigIssue(issue: ConfigIssue, t: Translate = fill): string {
  switch (issue.code) {
    case "schema":
      return t("{label}: {detail}", { label: issue.path, detail: issue.detail });
    case "shape":
      return t("Expected {expected}", issue);
    case "invalid":
      return issue.allowed === undefined
        ? t("{field} is not valid", { field: issue.field })
        : t("{field} must be one of {allowed}", {
            field: issue.field,
            allowed: issue.allowed.join(" / "),
          });
    case "needs_models":
      return t("A new provider needs models");
    case "unsupported_api":
      return t("Model {model}: api “{api}” is not supported", issue);
    case "needs_api":
      return t("Model {model} does not name an api", issue);
    case "needs_base_url":
      return t("Model {model} has no baseUrl", issue);
    case "no_auth":
      return t("No way to authenticate");
    case "env_unset":
      return t("{name} refers to an environment variable that is not set", issue);
    case "disconnected":
      return t("Disconnected");
    case "failed":
      return issue.detail;
  }
}

export function describeConfigProblem(problem: ConfigProblem, t: Translate = fill): string {
  const where = problem.entry === undefined ? problem.file : `${problem.file} · ${problem.entry}`;
  return `${where}: ${describeConfigIssue(problem, t)}`;
}
