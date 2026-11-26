import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationWindow, EntryId } from "@earendil-works/pi-durable";
import type { Schema, Static } from "@earendil-works/pi-schema";
import { TASK_FILTER_MAX_CONTEXT_LINES, validateOutputReadOptions } from "@eevee/agent";
import type {
  ListWorkerTasksOptions as CoreListWorkerTasksOptions,
  OutputReadOptions,
} from "@eevee/core";
import {
  type ConversationRef,
  ConversationRefSchema,
  type Problem,
  ProjectIdSchema,
  parseWithSchema,
  type QuestionId,
  QuestionIdSchema,
  type ScanOrder,
  ScanOrderSchema,
  type TaskListStatusFilter,
  TaskListStatusFilterSchema,
  type TaskReadMode,
  TaskReadModeSchema,
  validateWithSchema,
  type WorkerId,
  WorkerIdSchema,
} from "@eevee/protocol";
import { EngineError, type ListEntriesParams } from "./engine.ts";

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendProblem(
  res: ServerResponse,
  status: number,
  problem: Problem,
  extraHeaders?: Record<string, string>,
): void {
  sendJson(res, status, problem, extraHeaders);
}

export function sendMethodNotAllowed(res: ServerResponse, method: string, allow: string): void {
  sendProblem(
    res,
    405,
    { code: "method_not_allowed", message: `Method ${method} not allowed` },
    { Allow: allow },
  );
}

async function readRawBodyText(req: IncomingMessage): Promise<string> {
  const contentLengthHeader = req.headers["content-length"];
  if (contentLengthHeader !== undefined) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
      req.resume();
      throw new EngineError(
        413,
        "payload_too_large",
        `Request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
      );
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;

  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    totalBytes += buffer.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      chunks.length = 0;
      tooLarge = true;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }

  if (tooLarge) {
    throw new EngineError(
      413,
      "payload_too_large",
      `Request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
    );
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readRawBodyText(req);
  if (text.length === 0) {
    throw new EngineError(400, "invalid_json", "Request body must not be empty");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new EngineError(
      400,
      "invalid_json",
      "Malformed JSON request body",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function readOptionalJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readRawBodyText(req);
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new EngineError(
      400,
      "invalid_json",
      "Malformed JSON request body",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function readBody<S extends Schema>(
  req: IncomingMessage,
  schema: S,
  label: string,
): Promise<Static<S>> {
  return parseWithSchema(schema, await readJsonBody(req), label);
}

export async function readOptionalBody<S extends Schema>(
  req: IncomingMessage,
  schema: S,
  label: string,
): Promise<Static<S>> {
  return parseWithSchema(schema, await readOptionalJsonBody(req), label);
}

function parsePositiveInt(raw: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new EngineError(400, "invalid_query", `${label} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EngineError(400, "invalid_query", `${label} must be a positive safe integer`);
  }
  return value;
}

function parseNonNegativeInt(raw: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new EngineError(400, "invalid_query", `${label} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EngineError(400, "invalid_query", `${label} must be a non-negative safe integer`);
  }
  return value;
}

export function parseEntriesQuery(url: URL): ListEntriesParams {
  const orderParam = url.searchParams.get("order");
  let order: ScanOrder | undefined;
  if (orderParam !== null) {
    const checked = validateWithSchema(ScanOrderSchema, orderParam);
    if (!checked.ok) {
      throw new EngineError(
        400,
        "invalid_query",
        `Query parameter order must be ascending or descending`,
      );
    }
    order = checked.value;
  }

  const limitParam = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = parsePositiveInt(limitParam, "Query parameter limit");
    if (limit > 500) {
      throw new EngineError(400, "invalid_query", "Query parameter limit must be <= 500");
    }
  }

  const minEntryIdParam = url.searchParams.get("minEntryId");
  const minEntryId =
    minEntryIdParam === null
      ? undefined
      : parsePositiveInt(minEntryIdParam, "Query parameter minEntryId");

  const maxEntryIdParam = url.searchParams.get("maxEntryId");
  const maxEntryId =
    maxEntryIdParam === null
      ? undefined
      : parsePositiveInt(maxEntryIdParam, "Query parameter maxEntryId");

  const cursorParam = url.searchParams.get("cursor");

  return {
    ...(order === undefined ? {} : { order }),
    ...(limit === undefined ? {} : { limit }),
    ...(minEntryId === undefined ? {} : { minEntryId }),
    ...(maxEntryId === undefined ? {} : { maxEntryId }),
    ...(cursorParam === null ? {} : { cursor: cursorParam }),
  };
}

export type StreamWorkerTaskQuery = {
  readonly mode?: TaskReadMode;
  readonly bytes?: number;
  readonly sinceBytes?: number;
};

export function parseListWorkerTasksQuery(url: URL): CoreListWorkerTasksOptions {
  const statusParam = url.searchParams.get("status");
  let status: TaskListStatusFilter | undefined;
  if (statusParam !== null) {
    const checked = validateWithSchema(TaskListStatusFilterSchema, statusParam);
    if (!checked.ok) {
      throw new EngineError(
        400,
        "invalid_query",
        "Query parameter status must be all, active, or finished",
      );
    }
    status = checked.value;
  }

  const limitParam = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = parsePositiveInt(limitParam, "Query parameter limit");
    if (limit > 100) {
      throw new EngineError(400, "invalid_query", "Query parameter limit must be <= 100");
    }
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function parseReadWorkerTaskQuery(url: URL): OutputReadOptions {
  const modeParam = url.searchParams.get("mode");
  let mode: TaskReadMode | undefined;
  if (modeParam !== null) {
    const checked = validateWithSchema(TaskReadModeSchema, modeParam);
    if (!checked.ok) {
      throw new EngineError(400, "invalid_query", "Query parameter mode must be head or tail");
    }
    mode = checked.value;
  }

  const bytesParam = url.searchParams.get("bytes");
  const bytes =
    bytesParam === null ? undefined : parsePositiveInt(bytesParam, "Query parameter bytes");

  const sinceBytesParam = url.searchParams.get("sinceBytes");
  const sinceBytes =
    sinceBytesParam === null
      ? undefined
      : parseNonNegativeInt(sinceBytesParam, "Query parameter sinceBytes");

  const endByteParam = url.searchParams.get("endByte");
  const endByte =
    endByteParam === null
      ? undefined
      : parseNonNegativeInt(endByteParam, "Query parameter endByte");

  const filterParam = url.searchParams.get("filter");
  let filter: string | undefined;
  if (filterParam !== null) {
    if (filterParam.length === 0) {
      throw new EngineError(400, "invalid_query", "Query parameter filter must not be empty");
    }
    filter = filterParam;
  }

  const contextLinesParam = url.searchParams.get("contextLines");
  let contextLines: number | undefined;
  if (contextLinesParam !== null) {
    contextLines = parseNonNegativeInt(contextLinesParam, "Query parameter contextLines");
    if (contextLines > TASK_FILTER_MAX_CONTEXT_LINES) {
      throw new EngineError(
        400,
        "invalid_query",
        `Query parameter contextLines must be <= ${TASK_FILTER_MAX_CONTEXT_LINES}`,
      );
    }
    if (filter === undefined) {
      throw new EngineError(400, "invalid_query", "Query parameter contextLines requires filter");
    }
  }

  const options: OutputReadOptions = {
    ...(mode === undefined ? {} : { mode }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(sinceBytes === undefined ? {} : { sinceBytes }),
    ...(endByte === undefined ? {} : { endByte }),
    ...(filter === undefined ? {} : { filter }),
    ...(contextLines === undefined ? {} : { contextLines }),
  };

  try {
    validateOutputReadOptions(options);
  } catch (error) {
    throw new EngineError(
      400,
      "invalid_query",
      error instanceof Error ? error.message : String(error),
    );
  }

  return options;
}

export function parseStreamWorkerTaskQuery(url: URL): StreamWorkerTaskQuery {
  const modeParam = url.searchParams.get("mode");
  let mode: TaskReadMode | undefined;
  if (modeParam !== null) {
    const checked = validateWithSchema(TaskReadModeSchema, modeParam);
    if (!checked.ok) {
      throw new EngineError(400, "invalid_query", "Query parameter mode must be head or tail");
    }
    mode = checked.value;
  }

  const bytesParam = url.searchParams.get("bytes");
  const bytes =
    bytesParam === null ? undefined : parsePositiveInt(bytesParam, "Query parameter bytes");

  const sinceBytesParam = url.searchParams.get("sinceBytes");
  const sinceBytes =
    sinceBytesParam === null
      ? undefined
      : parseNonNegativeInt(sinceBytesParam, "Query parameter sinceBytes");

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(sinceBytes === undefined ? {} : { sinceBytes }),
  };
}

export function parseModelsQuery(url: URL): {
  readonly provider?: string;
  readonly available?: boolean;
} {
  const providerParam = url.searchParams.get("provider");
  const availableParam = url.searchParams.get("available");
  let available: boolean | undefined;
  if (availableParam !== null) {
    if (availableParam === "true") available = true;
    else if (availableParam === "false") available = false;
    else {
      throw new EngineError(
        400,
        "invalid_query",
        "Query parameter available must be true or false",
      );
    }
  }
  return {
    ...(providerParam !== null && providerParam.length > 0 ? { provider: providerParam } : {}),
    ...(available === undefined ? {} : { available }),
  };
}

export function parseWindowParams(url: URL, req: IncomingMessage): ConversationWindow | undefined {
  const fromParam = url.searchParams.get("from");
  const minParam = url.searchParams.get("min");
  const maxParam = url.searchParams.get("max");
  const lastEventIdRaw = req.headers["last-event-id"];
  const lastEventId = typeof lastEventIdRaw === "string" ? lastEventIdRaw.trim() : undefined;

  let from: EntryId | undefined;
  if (fromParam !== null) {
    from = parsePositiveInt(fromParam, "Query parameter from") as EntryId;
  } else if (lastEventId !== undefined && lastEventId.length > 0) {
    const parsedId = parsePositiveInt(lastEventId, "Header Last-Event-ID");
    from = (parsedId + 1) as EntryId;
  }

  const min = minParam !== null ? parsePositiveInt(minParam, "Query parameter min") : undefined;
  const max = maxParam !== null ? parsePositiveInt(maxParam, "Query parameter max") : undefined;

  const effectiveMin = min ?? 50;
  if (max !== undefined && max < effectiveMin) {
    throw new EngineError(
      400,
      "invalid_query",
      `Query parameter max (${max}) must be >= min (${effectiveMin})`,
    );
  }

  if (from === undefined && min === undefined && max === undefined) return undefined;
  return {
    ...(from === undefined ? {} : { from }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

function parseNonEmptySegment(raw: string, label: string): string {
  if (raw.trim().length === 0) {
    throw new EngineError(400, "invalid_request", `${label} must not be empty`);
  }
  return raw;
}

type PathParams = {
  readonly projectId: string;
  readonly ref: ConversationRef;
  readonly questionId: QuestionId;
  readonly workerId: WorkerId;
  readonly providerId: string;
  readonly sessionId: string;
  readonly serverName: string;
  readonly taskId: string;
};

const PATH_PARAM_PARSERS: { readonly [K in keyof PathParams]: (raw: string) => PathParams[K] } = {
  projectId: (raw) => parseWithSchema(ProjectIdSchema, raw, "projectId"),
  ref: (raw) => parseWithSchema(ConversationRefSchema, raw, "conversationRef"),
  questionId: (raw) => parseWithSchema(QuestionIdSchema, raw, "questionId"),
  workerId: (raw) => parseWithSchema(WorkerIdSchema, raw, "workerId"),
  providerId: (raw) => parseNonEmptySegment(raw, "providerId"),
  sessionId: (raw) => parseNonEmptySegment(raw, "sessionId"),
  serverName: (raw) => parseNonEmptySegment(raw, "serverName"),
  taskId: (raw) => parseNonEmptySegment(raw, "taskId"),
};

type ParamName<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamName<Rest>
  : Path extends `${string}:${infer Name}`
    ? Name
    : never;

type RouteContext<Path extends string> = {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Pick<PathParams, ParamName<Path> & keyof PathParams>;
};

export type Route = {
  readonly method: string;
  readonly pattern: readonly string[];
  readonly handle: (context: RouteContext<string>) => Promise<void> | void;
};

export function route<Path extends string>(
  method: string,
  path: Path,
  handle: (context: RouteContext<Path>) => Promise<void> | void,
): Route {
  return {
    method,
    pattern: path.split("/").filter((part) => part.length > 0),
    handle: handle as Route["handle"],
  };
}

export function matchesPattern(pattern: readonly string[], segments: readonly string[]): boolean {
  return (
    pattern.length === segments.length &&
    pattern.every((part, index) => part.startsWith(":") || part === segments[index])
  );
}

export function parsePathParams(
  pattern: readonly string[],
  segments: readonly string[],
): RouteContext<string>["params"] {
  const params: Record<string, unknown> = {};
  pattern.forEach((part, index) => {
    if (!part.startsWith(":")) return;
    const name = part.slice(1) as keyof PathParams;
    params[name] = PATH_PARAM_PARSERS[name](segments[index] ?? "");
  });
  return params;
}
