import {
  describeRunFailure,
  type JobOutcome,
  type Report,
  type ReportStatus,
  type RoleName,
  type RunFailureView,
  type TicketStage,
} from "../../../src/contracts/index.ts";
import { t } from "./i18n.ts";
import type { McpExposure } from "./mcp-draft.ts";
import type { DispatchActionKind } from "./transcript-map.ts";

/** Role names stay English in every language. */
export const ROLE_LABEL: Record<RoleName, string> = {
  router: "Router",
  worker: "Worker",
  dreamer: "Dreamer",
};

export const STAGE_LABEL: Record<TicketStage | "done" | "cancelled", string> = {
  answer: t("Needs answer"),
  review: t("Needs review"),
  blocked: t("Blocked"),
  queued: t("Queued"),
  working: t("Working"),
  jobs: t("Background jobs"),
  waiting: t("Waiting"),
  idle: t("Idle"),
  done: t("Done"),
  cancelled: t("Cancelled"),
};

export const REPORT_LABEL: Record<ReportStatus, string> = {
  progress: t("Progress"),
  waiting: t("Waiting::report"),
  ready: t("Ready"),
  blocked: t("Blocked"),
  failed: t("Failed"),
  dropped: t("Dropped"),
};

export const DISPATCH_LABEL: Record<DispatchActionKind, string> = {
  create: t("Create"),
  ask: t("Ask"),
  accept: t("Accept"),
  rework: t("Rework"),
  message: t("Message"),
  interrupt: t("Interrupt"),
  close: t("Cancel"),
  model: t("Model::change"),
};

/** How a server's tools reach the model, and which one it suits. */
export const EXPOSURE_LABEL: Record<McpExposure, { label: string; detail: string }> = {
  deferred: {
    label: t("On demand"),
    detail: t("Found on demand with tool_search; best when there are many tools"),
  },
  direct: {
    label: t("Direct"),
    detail: t("Offered up front like any other tool; best when there are only a few tools"),
  },
  codemode: {
    label: t("Code mode"),
    detail: t("Called only from codemode scripts; best for batched or combined calls"),
  },
  hidden: { label: t("Hidden"), detail: t("Stays connected but offers no tools") },
};

/** A failed run: why, then what the provider or runtime said about it. */
export function failureText(failure: RunFailureView): string {
  return describeRunFailure(failure, t);
}

export function jobStatusText(job: JobOutcome): string {
  if (job.status === "running") return t("Running");
  if (job.status === "killed") return t("Stopped");
  if (job.status === "interrupted") return t("Interrupted::job");
  if (job.error === "timeout") return t("Timed out");
  if (job.error !== undefined) return t("Error: {error}", { error: job.error });
  return job.exitCode === undefined ? t("Finished") : t("Exit {code}", { code: job.exitCode });
}

/** A report's summary; for one the Engine wrote in the Worker's place, the reason in the reader's words. */
export function reportSummary(report: Report): string {
  const origin = report.origin;
  if (origin?.type === "run-failed") {
    return t("The Worker's run failed: {reason}", { reason: failureText(origin.failure) });
  }
  if (origin?.type === "no-report" && !origin.answered) {
    return t("The turn ended without a report or a last answer");
  }
  return report.summary;
}

/** What a report says it needs; for one the Engine wrote, what to do next. */
export function reportNeed(report: Report): string | undefined {
  if (report.origin?.type === "run-failed")
    return t("Fix the cause and message it to continue, or cancel the ticket");
  if (report.origin?.type === "no-report")
    return t("No final report; read its last answer and decide what's next");
  return report.need;
}
