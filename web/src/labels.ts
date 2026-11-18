import type { RunFailureReason } from "@earendil-works/pi-durable";
import type {
  JobOutcome,
  Report,
  ReportStatus,
  RoleName,
  RunFailureView,
  TicketStage,
} from "../../src/contracts/index.ts";
import { t } from "./i18n.ts";
import type { DispatchActionKind } from "./transcript-map.ts";

/** Role names stay English in every language. */
export const ROLE_LABEL: Record<RoleName, string> = {
  router: "Router",
  worker: "Worker",
  dreamer: "Dreamer",
};

export const STAGE_LABEL: Record<TicketStage | "done" | "cancelled", string> = {
  answer: t("待回答"),
  review: t("待验收"),
  blocked: t("受阻"),
  queued: t("排队中"),
  working: t("执行中"),
  jobs: t("后台作业"),
  waiting: t("等待中"),
  idle: t("空闲"),
  done: t("已结单"),
  cancelled: t("已取消"),
};

export const REPORT_LABEL: Record<ReportStatus, string> = {
  progress: t("进展"),
  waiting: t("等待"),
  ready: t("完成"),
  blocked: t("受阻"),
  failed: t("失败"),
  dropped: t("放弃"),
};

export const DISPATCH_LABEL: Record<DispatchActionKind, string> = {
  create: t("建单"),
  ask: t("提问"),
  accept: t("验收"),
  rework: t("打回"),
  message: t("发消息"),
  interrupt: t("打断"),
  close: t("取消"),
  model: t("换模型"),
};

export const FAILURE_LABEL: Record<RunFailureReason, string> = {
  model_error: t("模型调用失败"),
  no_model: t("没有配置模型"),
  aborted: t("已中止"),
  reset: t("上下文被重置"),
  faulted: t("运行出错"),
  orphaned: t("运行无法继续"),
  interrupted: t("运行被中断"),
  restart_limit: t("多次重启后放弃"),
  nothing_to_answer: t("没有需要回答的内容"),
  turn_limit: t("超出轮次上限"),
};

/** A failed run: why, then what the provider or runtime said about it. */
export function failureText(failure: RunFailureView): string {
  const label = FAILURE_LABEL[failure.reason] ?? failure.reason;
  return failure.detail === undefined
    ? label
    : t("{label}：{detail}", { label, detail: failure.detail });
}

/** Where a background job stands, or how it ended. */
export function jobStatusText(job: JobOutcome): string {
  if (job.status === "running") return t("运行中");
  if (job.status === "killed") return t("已终止");
  if (job.status === "interrupted") return t("被打断");
  if (job.error === "timeout") return t("超时终止");
  if (job.error !== undefined) return t("出错：{error}", { error: job.error });
  return job.exitCode === undefined ? t("已结束") : t("退出码 {code}", { code: job.exitCode });
}

/** A report's summary; for one the Engine wrote in the Worker's place, the reason in the reader's words. */
export function reportSummary(report: Report): string {
  const origin = report.origin;
  if (origin?.type === "run-failed") {
    return t("执行对话运行失败：{reason}", { reason: failureText(origin.failure) });
  }
  if (origin?.type === "no-report" && !origin.answered) {
    return t("本轮结束，但没有提交报告，也没有留下回答");
  }
  return report.summary;
}

/** What a report says it needs; for one the Engine wrote, what to do next. */
export function reportNeed(report: Report): string | undefined {
  if (report.origin?.type === "run-failed") return t("排除原因后发消息让它继续，或者取消工单");
  if (report.origin?.type === "no-report") return t("没有提交收尾报告，看它的最后回答再决定下一步");
  return report.need;
}
