import type { ChatLine } from "@shared/api/contract.ts";
import type { ReportStatus, TicketStage } from "@shared/contracts/index.ts";

export const STAGE_LABEL: Record<TicketStage, string> = {
  answer: "待回答",
  review: "待验收",
  blocked: "受阻",
  queued: "排队中",
  working: "执行中",
  jobs: "后台作业",
  waiting: "等待中",
  idle: "空闲",
};

export const REPORT_LABEL: Record<ReportStatus, string> = {
  progress: "进展",
  waiting: "等待",
  ready: "完成",
  blocked: "受阻",
  failed: "失败",
  dropped: "放弃",
};

export const ROLE_LABEL: Record<ChatLine["role"], string> = {
  user: "你",
  assistant: "Router",
  tool: "工具",
  notice: "通知",
  reset: "交接",
};
