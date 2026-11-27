import type {
  BackgroundTaskStatus,
  NoticeData,
  TaskNotificationData,
  TicketId,
  WorkerId,
} from "@eevee/protocol";
import { taskStatusLabel, taskStatusStage, taskStatusTone } from "../../lib/format.ts";
import { type LocaleKey, t } from "../../lib/i18n.ts";
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
  { readonly key: LocaleKey; readonly danger?: true }
> = {
  completed: { key: "transcript.notice.taskCompleted" },
  failed: { key: "transcript.notice.taskFailed", danger: true },
  timed_out: { key: "transcript.notice.taskTimedOut", danger: true },
  cancelled: { key: "transcript.notice.taskCancelled" },
  interrupted: { key: "transcript.notice.taskInterrupted", danger: true },
  queued: { key: "transcript.notice.taskGeneric" },
  running: { key: "transcript.notice.taskGeneric" },
  stopping: { key: "transcript.notice.taskGeneric" },
};

function taskNotificationLabel(data: TaskNotificationData): NoticeLabelInfo {
  const spec = TASK_TITLES[data.status];
  const badgeText =
    data.status === "cancelled" && data.cancelReason === "user"
      ? "cancelled (user)"
      : taskStatusLabel(data.status, data.exitCode);
  return {
    title: t(spec.key, { taskId: data.taskId }),
    tone: spec.danger ? "danger" : "default",
    stage: taskStatusStage(data.status),
    badge: { text: badgeText, tone: taskStatusTone(data.status) },
  };
}

function noticeDataLabel(data: NoticeData): NoticeLabelInfo {
  switch (data.type) {
    case "handoff":
      return {
        title: t("transcript.notice.handoff", { name: data.workerName || data.workerId }),
        tone: "default",
        stage: "done",
        workerId: data.workerId,
        ...(data.ticketId !== undefined ? { ticketId: data.ticketId } : {}),
      };
    case "worker_message":
      return {
        title: t("transcript.notice.workerMessage", { name: data.workerName || data.workerId }),
        tone: "default",
        stage: "done",
        workerId: data.workerId,
        ...(data.ticketId !== undefined ? { ticketId: data.ticketId } : {}),
      };
    case "worker_failed":
      return {
        title: t("transcript.notice.workerFailed", { name: data.workerName || data.workerId }),
        tone: "danger",
        stage: "blocked",
        workerId: data.workerId,
        ...(data.ticketId !== undefined ? { ticketId: data.ticketId } : {}),
      };
    case "question_answered":
      return {
        title: t("transcript.notice.questionAnswered", { questionId: data.questionId }),
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
      return {
        title: t("transcript.notice.generic", { type: meta.type }),
        tone: "default",
        stage: "done",
      };
  }
}
