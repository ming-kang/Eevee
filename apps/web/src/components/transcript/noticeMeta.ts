import type { BackgroundTaskStatus } from "@eevee/protocol";
import { taskStatusLabel, taskStatusStage, taskStatusTone } from "../../lib/format.ts";
import type { DisplayItem, VisualStage } from "../../lib/transcript.ts";

export type NoticeLabelInfo = {
  readonly title: string;
  readonly tone: "default" | "danger";
  readonly stage: VisualStage;
  readonly badge?: {
    readonly text: string;
    readonly tone: "info" | "positive" | "warning" | "negative" | "neutral";
  };
};

const TASK_TITLES: Record<
  BackgroundTaskStatus,
  { readonly prefix: string; readonly danger?: true }
> = {
  completed: { prefix: "后台任务完成" },
  failed: { prefix: "后台任务失败", danger: true },
  timed_out: { prefix: "后台任务超时", danger: true },
  cancelled: { prefix: "后台任务已取消" },
  interrupted: { prefix: "后台任务中断", danger: true },
  queued: { prefix: "后台任务" },
  running: { prefix: "后台任务" },
  stopping: { prefix: "后台任务" },
};

function taskNotificationLabel(
  meta: Extract<DisplayItem, { kind: "notice" }>["meta"],
): NoticeLabelInfo {
  const idSuffix = meta.taskId ? ` · ${meta.taskId}` : "";
  const status = meta.taskStatus;
  if (status === undefined) {
    return { title: `后台任务${idSuffix}`, tone: "default", stage: "done" };
  }
  const spec = TASK_TITLES[status];
  const badgeText =
    status === "cancelled" && meta.taskCancelReason === "user"
      ? "cancelled (user)"
      : taskStatusLabel(status, meta.taskExitCode);
  return {
    title: `${spec.prefix}${idSuffix}`,
    tone: spec.danger ? "danger" : "default",
    stage: taskStatusStage(status),
    badge: { text: badgeText, tone: taskStatusTone(status) },
  };
}

export function noticeMetaLabel(
  meta: Extract<DisplayItem, { kind: "notice" }>["meta"],
): NoticeLabelInfo {
  switch (meta.type) {
    case "handoff":
      return {
        title: `Worker 交棒 · ${meta.workerName ?? meta.workerId ?? ""}`,
        tone: "default",
        stage: "done",
      };
    case "worker_message":
      return {
        title: `Worker 消息 · ${meta.workerName ?? meta.workerId ?? ""}`,
        tone: "default",
        stage: "done",
      };
    case "worker_failed":
      return {
        title: `Worker 失败 · ${meta.workerName ?? meta.workerId ?? ""}`,
        tone: "danger",
        stage: "blocked",
      };
    case "question_answered":
      return { title: `用户答复 · ${meta.questionId ?? ""}`, tone: "default", stage: "done" };
    case "task_notification":
      return taskNotificationLabel(meta);
    default:
      return { title: `通知 · ${meta.type}`, tone: "default", stage: "done" };
  }
}
