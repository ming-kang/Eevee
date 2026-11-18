import type { LiveState, RunFailure, RunFailureReason } from "@earendil-works/pi-durable";

const FAILURE_LABEL: Record<RunFailureReason, string> = {
  model_error: "Model call failed",
  no_model: "No model configured",
  aborted: "Aborted",
  reset: "Context was reset",
  faulted: "The run failed",
  orphaned: "The run cannot continue",
  interrupted: "The run was interrupted",
  restart_limit: "Gave up after repeated restarts",
  nothing_to_answer: "Nothing left to answer",
  turn_limit: "Turn limit reached",
};

/** Ends that are someone's decision, not a failure: an interrupt, a reset, a continue with nothing to do. */
const DELIBERATE: ReadonlySet<RunFailureReason> = new Set([
  "aborted",
  "reset",
  "nothing_to_answer",
]);

export function isDeliberateEnd(reason: RunFailureReason): boolean {
  return DELIBERATE.has(reason);
}

export function describeRunFailure(failure: Pick<RunFailure, "reason" | "detail">): string {
  const label = FAILURE_LABEL[failure.reason] ?? failure.reason;
  return failure.detail === undefined ? label : `${label}: ${failure.detail}`;
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

/** Sums up a conversation's `pi.live` document. */
export function summarizeRun(live: Pick<LiveState, "run" | "runFailure"> | undefined): RunSummary {
  if (live?.run !== undefined) return { running: true };
  const failure = live?.runFailure;
  if (failure === undefined || isDeliberateEnd(failure.reason)) return { running: false };
  return { running: false, failure: failureView(failure) };
}
