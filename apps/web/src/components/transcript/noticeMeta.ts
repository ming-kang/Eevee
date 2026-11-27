import type {
  BackgroundTaskStatus,
  NoticeData,
  TaskNotificationData,
  TicketId,
  WorkerId,
} from "@eevee/protocol";
import { taskStatusLabel, taskStatusStage, taskStatusTone } from "../../lib/format.ts";
import type { NoticeInfo, VisualStage } from "../../lib/transcript.ts";

export type NoticeLabelInfo = {
  readonly title: string;
  readonly tone: "default" | "danger";
  readonly stage: VisualStage;
  readonly workerId?: WorkerId;
  readonly ticketId?: TicketId;
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

function taskNotificationLabel(data: TaskNotificationData): NoticeLabelInfo {
  const spec = TASK_TITLES[data.status];
  const badgeText =
    data.status === "cancelled" && data.cancelReason === "user"
      ? "cancelled (user)"
      : taskStatusLabel(data.status, data.exitCode);
  return {
    title: `${spec.prefix} · ${data.taskId}`,
    tone: spec.danger ? "danger" : "default",
    stage: taskStatusStage(data.status),
    badge: { text: badgeText, tone: taskStatusTone(data.status) },
  };
}

function noticeDataLabel(data: NoticeData): NoticeLabelInfo {
  switch (data.type) {
    case "handoff":
      return {
        title: `Worker 交棒 · ${data.workerName || data.workerId}`,
        tone: "default",
        stage: "done",
        workerId: data.workerId,
        ...(data.ticketId !== undefined ? { ticketId: data.ticketId } : {}),
      };
    case "worker_message":
      return {
        title: `Worker 消息 · ${data.workerName || data.workerId}`,
        tone: "default",
        stage: "done",
        workerId: data.workerId,
        ...(data.ticketId !== undefined ? { ticketId: data.ticketId } : {}),
      };
    case "worker_failed":
      return {
        title: `Worker 失败 · ${data.workerName || data.workerId}`,
        tone: "danger",
        stage: "blocked",
        workerId: data.workerId,
        ...(data.ticketId !== undefined ? { ticketId: data.ticketId } : {}),
      };
    case "question_answered":
      return {
        title: `用户答复 · ${data.questionId}`,
        tone: "default",
        stage: "done",
      };
  }
}

export function noticeMetaLabel(meta: NoticeInfo): NoticeLabelInfo {
  switch (meta.kind) {
    case "notice":
      return noticeDataLabel(meta.data);
    case "task_notification":
      return taskNotificationLabel(meta.data);
    case "generic":
      return { title: `通知 · ${meta.type}`, tone: "default", stage: "done" };
  }
}
