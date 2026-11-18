import type { LiveState, RunFailure, RunFailureReason } from "@earendil-works/pi-durable";

const FAILURE_LABEL: Record<RunFailureReason, string> = {
  model_error: "模型调用失败",
  no_model: "没有配置模型",
  aborted: "已中止",
  reset: "上下文被重置",
  faulted: "运行出错",
  orphaned: "运行无法继续",
  interrupted: "运行被中断",
  restart_limit: "多次重启后放弃",
  nothing_to_answer: "没有需要回答的内容",
  turn_limit: "超出轮次上限",
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
  return failure.detail === undefined ? label : `${label}：${failure.detail}`;
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
