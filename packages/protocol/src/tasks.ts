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

export function validateTaskReadOptions(
  options: { readonly filter?: string; readonly contextLines?: number } = {},
): ((line: string) => boolean) | undefined {
  const filter = options.filter !== undefined && options.filter !== "" ? options.filter : undefined;
  if (options.contextLines !== undefined) {
    if (filter === undefined) {
      throw new Error("contextLines requires filter");
    }
    if (
      !Number.isInteger(options.contextLines) ||
      options.contextLines < 0 ||
      options.contextLines > TASK_FILTER_MAX_CONTEXT_LINES
    ) {
      throw new Error(
        `Invalid contextLines: must be an integer between 0 and ${TASK_FILTER_MAX_CONTEXT_LINES}`,
      );
    }
  }
  return filter !== undefined ? buildTaskLineMatcher(filter) : undefined;
}
