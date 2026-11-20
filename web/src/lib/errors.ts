import {
  type ConfigIssue,
  type ConfigProblem,
  describeConfigIssue,
  describeProblem,
  type Problem,
} from "../../../src/domain/index.ts";
import { ApiRequestError } from "../../../src/protocol/client.ts";
import { t } from "./i18n.ts";
import { StreamError } from "./stream.ts";

/** Why the Engine refused, in the reader's words. Only an unforeseen error shows its own text. */
export function problemText(problem: Problem): string {
  return describeProblem(problem, t);
}

export function configIssueText(issue: ConfigIssue): string {
  return describeConfigIssue(issue, t);
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
  if (cause instanceof ApiRequestError) return problemText(cause.body);
  if (cause instanceof StreamError) {
    return problemText(cause.problem);
  }
  return cause instanceof Error ? cause.message : String(cause);
}
