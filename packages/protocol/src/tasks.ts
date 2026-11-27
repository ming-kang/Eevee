import type { BackgroundTaskStatus } from "./schemas/common.ts";

export const TASK_FILTER_MAX_CONTEXT_LINES = 5;

export function isActiveTaskStatus(status: BackgroundTaskStatus): boolean {
  switch (status) {
    case "queued":
    case "running":
    case "stopping":
      return true;
    case "completed":
    case "failed":
    case "timed_out":
    case "cancelled":
    case "interrupted":
      return false;
  }
}

export function buildTaskLineMatcher(
  rawFilter: string,
  label = "filter",
): (line: string) => boolean {
  if (rawFilter.length === 0) {
    throw new Error(`Invalid ${label}: must not be empty`);
  }
  const regexMatch = /^\/(.+)\/([dgimsuvy]*)$/.exec(rawFilter);
  if (regexMatch !== null) {
    const pattern = regexMatch[1] ?? "";
    const flags = regexMatch[2] ?? "";
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(
        `Invalid filter regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const stateless = new RegExp(pattern, flags.replace(/[gy]/g, ""));
    return (line) => stateless.test(line);
  }
  const needle = rawFilter.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}
