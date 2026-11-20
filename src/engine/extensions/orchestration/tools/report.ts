import { defineTool } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { REPORT_SUMMARY_LIMIT } from "../../../../domain/index.ts";
import type { OrchestrationDeps } from "../../../orchestration/ports.ts";
import { executeReport } from "../../../orchestration/report.ts";
import { toolResult } from "../result.ts";

export const REPORT_TOOL = "report";

const Parameters = obj({
  status: oneOf(["progress", "waiting", "ready", "blocked", "failed", "dropped"], {
    description:
      "progress: a step forward, keep working; waiting: something is missing; " +
      "ready: done and waiting for review; blocked: cannot go on; " +
      "failed: the work did not succeed; dropped: the work turned out to be unnecessary",
  }),
  summary: str({ maxLength: REPORT_SUMMARY_LIMIT, description: "A summary for the Router" }),
  detail: opt(str({ description: "The full content, read when the Router needs it" })),
  artifacts: arr(obj({ path: str(), note: str() }), {
    description: "Artifact files with a one-line note each",
  }),
  need: opt(str({ description: "What is missing; use it with the waiting status" })),
  questions: opt(
    arr(obj({ text: str(), options: arr(str()), recommended: opt(str()) }), {
      description: "Questions the user has to decide",
    }),
  ),
  lessons: opt(arr(str(), { description: "Lessons worth remembering for the long term" })),
});

export function createReportTool(deps: OrchestrationDeps) {
  return defineTool({
    name: REPORT_TOOL,
    description:
      "Submit a report to the Router. Every status but progress ends this turn, so call it on its own and put it " +
      "last when you wrap up.",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    execute: (args, api, context) => executeReport(deps, args, api, context).then(toolResult),
  });
}
