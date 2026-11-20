import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { OrchestrationResult } from "../../orchestration/result.ts";

export function toolResult(result: OrchestrationResult): ToolExecutionResult {
  return {
    output: [{ type: "text", text: result.text }],
    ...(result.details === undefined ? {} : { details: result.details }),
    ...(result.control === undefined ? {} : { control: result.control }),
    ...(result.error ? { isError: true } : {}),
  };
}
