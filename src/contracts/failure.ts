import type { LiveState, RunFailure, RunFailureReason } from "@earendil-works/pi-durable";
import { fill, type Translate } from "./text.ts";

function reasonText(reason: RunFailureReason, t: Translate): string {
  switch (reason) {
    case "model_error":
      return t("Model call failed");
    case "no_model":
      return t("No model configured");
    case "aborted":
      return t("Aborted");
    case "reset":
      return t("Context was reset");
    case "faulted":
      return t("The run hit an error");
    case "orphaned":
      return t("The run cannot continue");
    case "interrupted":
      return t("The run was interrupted");
    case "restart_limit":
      return t("Gave up after repeated restarts");
    case "nothing_to_answer":
      return t("Nothing to answer");
    case "turn_limit":
      return t("Turn limit reached");
    default:
      return reason;
  }
}

/** Ends that are someone's decision, not a failure: an interrupt, a reset, a continue with nothing to do. */
const DELIBERATE: ReadonlySet<RunFailureReason> = new Set([
  "aborted",
  "reset",
  "nothing_to_answer",
]);

export function isDeliberateEnd(reason: RunFailureReason): boolean {
  return DELIBERATE.has(reason);
}

export function describeRunFailure(
  failure: Pick<RunFailure, "reason" | "detail">,
  t: Translate = fill,
): string {
  const label = reasonText(failure.reason, t);
  return failure.detail === undefined
    ? label
    : t("{label}: {detail}", { label, detail: failure.detail });
}

/** Why a run failed, and the provider's or runtime's own words for it, if any: each reader words the reason. */
export type RunFailureView = Pick<RunFailure, "reason" | "detail">;

export function failureView(failure: Pick<RunFailure, "reason" | "detail">): RunFailureView {
  return failure.detail === undefined
    ? { reason: failure.reason }
    : { reason: failure.reason, detail: failure.detail };
}

/** Whether a conversation runs, and how its last run failed when that was not a deliberate end. */
export type RunSummary = {
  running: boolean;
  failure?: RunFailureView;
};

export function summarizeRun(live: Pick<LiveState, "run" | "runFailure"> | undefined): RunSummary {
  if (live?.run !== undefined) return { running: true };
  const failure = live?.runFailure;
  if (failure === undefined || isDeliberateEnd(failure.reason)) return { running: false };
  return { running: false, failure: failureView(failure) };
}
