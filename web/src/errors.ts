import { ApiRequestError } from "../../src/api/client.ts";
import type { ConfigIssue, ConfigProblem, Problem } from "../../src/contracts/index.ts";
import { t } from "./i18n.ts";
import { ROLE_LABEL } from "./labels.ts";
import { StreamError } from "./stream.ts";

const list = (items: readonly string[]): string => items.join(t(", "));

/** Why the Engine refused, in the reader's words. Only an unforeseen error shows its own text. */
export function problemText(problem: Problem): string {
  switch (problem.code) {
    case "unauthorized":
      return t("Not signed in; run eevee to open the panel");
    case "bad_code":
      return t("This sign-in code is invalid or expired; run eevee again");
    case "forbidden_host":
      return t("Only requests from this machine are accepted");
    case "no_route":
      return t("No endpoint {method} {path}", problem);
    case "no_file":
      return t("No such file");
    case "bad_json":
      return t("The request body isn't valid JSON");
    case "too_large":
      return t("The request is too large");
    case "required":
      return t("{field} can't be empty", problem);
    case "invalid":
      return problem.allowed === undefined
        ? t("{field} is invalid", { field: problem.field })
        : t("{field} must be one of {allowed}", {
            field: problem.field,
            allowed: problem.allowed.join(" / "),
          });
    case "no_project":
      return t("Project not found");
    case "no_ticket":
      return t("No ticket {ticketId}", problem);
    case "no_worker":
      return t("{ticketId} has no Worker conversation", problem);
    case "no_question":
      return t("No question {questionId}", problem);
    case "no_job":
      return t("No job {jobId}", problem);
    case "no_memory_file":
      return t("No memory file {file}", problem);
    case "no_commit":
      return t("No commit {commit}", problem);
    case "no_model":
      return t("No model {provider}/{modelId}", problem);
    case "no_provider":
      return t("No provider {provider}", problem);
    case "no_extension":
      return t("Not installed: {names}", { names: list(problem.names) });
    case "model_unset":
      return t("{role} has no model", { role: ROLE_LABEL[problem.role] });
    case "ticket_closed":
      return t("{ticketId} is already closed", problem);
    case "report_changed":
      return t("The report waiting on {ticketId} changed; read the latest one first", problem);
    case "answered":
      return t("{questionId} is already answered", problem);
    case "job_ended":
      return t("Job {jobId} has already ended", problem);
    case "running":
      return t("The conversation is running");
    case "not_failed":
      return t("The last turn didn't fail; there's nothing to retry");
    case "revert_failed":
      return t(
        "Couldn't revert {commit}: no such commit, or it conflicts with later changes",
        problem,
      );
    case "bad_config":
      return problem.problems.map(configProblemText).join("\n");
    case "model_in_use":
      return t("{model} is a default model; change the default first", {
        model: `${problem.provider}/${problem.modelId}`,
      });
    case "probe_failed":
      return t("Could not fetch the model list: {detail}", problem);
    case "internal":
      return problem.detail;
  }
}

/** What is wrong with a config file or something loaded from it, in the reader's words. */
export function configIssueText(issue: ConfigIssue): string {
  switch (issue.code) {
    case "schema":
      return t("{label}: {detail}", { label: issue.path, detail: issue.detail });
    case "shape":
      return t("Should be {expected}", issue);
    case "invalid":
      return issue.allowed === undefined
        ? t("{field} is invalid", { field: issue.field })
        : t("{field} must be one of {allowed}", {
            field: issue.field,
            allowed: issue.allowed.join(" / "),
          });
    case "needs_models":
      return t("A new provider needs models");
    case "unsupported_api":
      return t("Model {model}: api “{api}” isn't supported", issue);
    case "needs_api":
      return t("Model {model} has no api", issue);
    case "needs_base_url":
      return t("Model {model} has no baseUrl", issue);
    case "no_auth":
      return t("No way to authenticate");
    case "env_unset":
      return t("{name} refers to an environment variable that isn't set", issue);
    case "name_taken":
      return t("Another file already uses the extension name {name}", issue);
    case "name_reserved":
      return t("The extension name {name} is reserved by Eevee", issue);
    case "bad_export":
      return t("The default export should be an extension, or a function returning one");
    case "disconnected":
      return t("Disconnected");
    case "failed":
      return issue.detail;
  }
}

/** A config problem under a heading that already names its file: the entry, then what is wrong. */
export function configProblemText(problem: ConfigProblem): string {
  const issue = configIssueText(problem);
  return problem.entry === undefined
    ? issue
    : t("{label}: {detail}", { label: problem.entry, detail: issue });
}

/** What to show for anything a call threw: a refusal in the reader's words, else the error's text. */
export function errorText(cause: unknown): string {
  if (cause instanceof ApiRequestError || cause instanceof StreamError) {
    return problemText(cause.problem);
  }
  return cause instanceof Error ? cause.message : String(cause);
}
