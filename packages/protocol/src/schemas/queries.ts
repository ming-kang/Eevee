import { bool, int, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { TASK_FILTER_MAX_CONTEXT_LINES } from "../tasks.ts";
import { ScanOrderSchema, TaskListStatusFilterSchema, TaskReadModeSchema } from "./common.ts";

export const EntriesQuerySchema = obj({
  order: opt(ScanOrderSchema),
  limit: opt(int({ minimum: 1, maximum: 500 })),
  minEntryId: opt(int({ minimum: 1 })),
  maxEntryId: opt(int({ minimum: 1 })),
  cursor: opt(str()),
});
export type EntriesQuery = Static<typeof EntriesQuerySchema>;

export const ListWorkerTasksQuerySchema = obj({
  status: opt(TaskListStatusFilterSchema),
  limit: opt(int({ minimum: 1, maximum: 100 })),
});
export type ListWorkerTasksQuery = Static<typeof ListWorkerTasksQuerySchema>;

const TASK_STREAM_QUERY_PROPERTIES = {
  mode: opt(TaskReadModeSchema),
  bytes: opt(int({ minimum: 1 })),
  sinceBytes: opt(int({ minimum: 0 })),
} as const;

export const StreamWorkerTaskQuerySchema = obj(TASK_STREAM_QUERY_PROPERTIES);
export type StreamWorkerTaskQuery = Static<typeof StreamWorkerTaskQuerySchema>;

export const ReadWorkerTaskQuerySchema = obj({
  ...TASK_STREAM_QUERY_PROPERTIES,
  endByte: opt(int({ minimum: 0 })),
  filter: opt(str({ minLength: 1 })),
  contextLines: opt(int({ minimum: 0, maximum: TASK_FILTER_MAX_CONTEXT_LINES })),
});
export type ReadWorkerTaskQuery = Static<typeof ReadWorkerTaskQuerySchema>;

export const ModelsQuerySchema = obj({
  provider: opt(str({ minLength: 1 })),
  available: opt(bool()),
});
export type ModelsQuery = Static<typeof ModelsQuerySchema>;

export const WindowQuerySchema = obj({
  from: opt(int({ minimum: 1 })),
  min: opt(int({ minimum: 1 })),
  max: opt(int({ minimum: 1 })),
});
export type WindowQuery = Static<typeof WindowQuerySchema>;
