import type { ReportStatus, TicketStage } from "../../src/contracts/index.ts";
import { t } from "./i18n.ts";
import type { DispatchActionKind } from "./transcript-map.ts";

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
