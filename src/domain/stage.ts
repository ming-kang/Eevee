import { isFinalReport, type Report } from "./domain.ts";

export type TicketStage =
  | "answer"
  | "review"
  | "blocked"
  | "queued"
  | "working"
  | "jobs"
  | "waiting"
  | "idle";

export type StageFacts = {
  openQuestion: boolean;
  reports: readonly Pick<Report, "seq" | "status" | "handled">[];
  queued: boolean;
  running: boolean;
  jobsRunning: boolean;
};

export const STAGE_NEEDS: Record<TicketStage, "user" | "router" | null> = {
  answer: "user",
  review: "router",
  blocked: "router",
  queued: null,
  working: null,
  jobs: null,
  waiting: null,
  idle: null,
};

export function latestFinalReport<R extends Pick<Report, "seq" | "status">>(
  reports: readonly R[],
): R | undefined {
  let latest: R | undefined;
  for (const report of reports) {
    if (isFinalReport(report.status) && (latest === undefined || report.seq > latest.seq)) {
      latest = report;
    }
  }
  return latest;
}

export function deriveStage(facts: StageFacts): TicketStage {
  const final = latestFinalReport(facts.reports);
  const pending = final !== undefined && !final.handled ? final.status : undefined;
  if (facts.openQuestion) return "answer";
  if (pending === "ready") return "review";
  if (pending === "blocked" || pending === "failed" || pending === "dropped") return "blocked";
  if (facts.queued) return "queued";
  if (facts.running) return "working";
  if (facts.jobsRunning) return "jobs";
  if (final?.status === "waiting") return "waiting";
  return "idle";
}
