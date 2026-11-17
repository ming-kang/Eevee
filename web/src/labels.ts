import type { ReportStatus, TicketStage } from "../../src/contracts/index.ts";
import type { DispatchActionKind } from "./transcript-map.ts";

export const STAGE_LABEL: Record<TicketStage | "done" | "cancelled", string> = {
  answer: "待回答",
  review: "待验收",
  blocked: "受阻",
  queued: "排队中",
  working: "执行中",
  jobs: "后台作业",
  waiting: "等待中",
  idle: "空闲",
  done: "已结单",
  cancelled: "已取消",
};

export const REPORT_LABEL: Record<ReportStatus, string> = {
  progress: "进展",
  waiting: "等待",
  ready: "完成",
  blocked: "受阻",
  failed: "失败",
  dropped: "放弃",
};

export const DISPATCH_LABEL: Record<DispatchActionKind, string> = {
  create: "建单",
  ask: "提问",
  accept: "验收",
  rework: "打回",
  message: "发消息",
  interrupt: "打断",
  close: "取消",
  model: "换模型",
};
