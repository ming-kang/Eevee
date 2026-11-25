import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationWindow, EntryId } from "@earendil-works/pi-durable";
import type { Schema, Static } from "@earendil-works/pi-schema";
import type { OutputReadOptions } from "@eevee/core";
import {
  AnswerQuestionRequestSchema,
  ConfigBundleSchema,
  type ConversationRef,
  ConversationRefSchema,
  CreateProjectRequestSchema,
  EngineSettingsSchema,
  LoginInputRequestSchema,
  ModelProfilesDocumentSchema,
  type Problem,
  ProjectIdSchema,
  PutMcpConfigRequestSchema,
  PutProjectMemoryRequestSchema,
  parseWithSchema,
  type QuestionId,
  QuestionIdSchema,
  ReconnectMcpRequestSchema,
  RefreshModelsRequestSchema,
  type ScanOrder,
  ScanOrderSchema,
  SchemaValidationError,
  SendMessageRequestSchema,
  SetApiKeyRequestSchema,
  StartLoginRequestSchema,
  type TaskReadMode,
  TaskReadModeSchema,
  UpdateProjectRequestSchema,
  UpsertMcpServerRequestSchema,
  validateWithSchema,
  type WorkerId,
  WorkerIdSchema,
} from "@eevee/protocol";
import { verifyBearerToken } from "./auth.ts";
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "./constants.ts";
import { type Engine, EngineError, type ListEntriesParams, type LoginSseFrame } from "./engine.ts";

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const SSE_KEEPALIVE_MS = 20_000;

export type EngineHttpServerOptions = {
  readonly host?: string;
  readonly port?: number;
  readonly token: string;
  readonly onShutdown?: () => void;
};

export type EngineHttpServer = {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
};

function sendJson(
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

function sendProblem(
  res: ServerResponse,
  status: number,
  problem: Problem,
  extraHeaders?: Record<string, string>,
): void {
  sendJson(res, status, problem, extraHeaders);
}

function sendMethodNotAllowed(res: ServerResponse, method: string, allow: string): void {
  sendProblem(
    res,
    405,
    { code: "method_not_allowed", message: `Method ${method} not allowed` },
    { Allow: allow },
  );
}

function writeSseEvent(
  res: ServerResponse,
  event: string,
  data: unknown,
  id?: string | number,
): void {
  if (res.writableEnded || res.destroyed) return;
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${String(id)}`);
  lines.push(`event: ${event}`);
  const payload = JSON.stringify(data);
  for (const line of payload.split("\n")) {
    lines.push(`data: ${line}`);
  }
  res.write(`${lines.join("\n")}\n\n`);
}

function writeSseComment(res: ServerResponse, comment: string): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`: ${comment}\n\n`);
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

async function readOptionalJsonBody(req: IncomingMessage): Promise<unknown> {
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

function parseEntriesQuery(url: URL): ListEntriesParams {
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

function parseReadWorkerTaskQuery(url: URL): OutputReadOptions {
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

function parseModelsQuery(url: URL): {
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

function parseWindowParams(url: URL, req: IncomingMessage): ConversationWindow | undefined {
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

type Route = {
  readonly method: string;
  readonly pattern: readonly string[];
  readonly handle: (context: RouteContext<string>) => Promise<void> | void;
};

function route<Path extends string>(
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

function matchesPattern(pattern: readonly string[], segments: readonly string[]): boolean {
  return (
    pattern.length === segments.length &&
    pattern.every((part, index) => part.startsWith(":") || part === segments[index])
  );
}

function parsePathParams(
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

async function readBody<S extends Schema>(
  req: IncomingMessage,
  schema: S,
  label: string,
): Promise<Static<S>> {
  return parseWithSchema(schema, await readJsonBody(req), label);
}

async function readOptionalBody<S extends Schema>(
  req: IncomingMessage,
  schema: S,
  label: string,
): Promise<Static<S>> {
  return parseWithSchema(schema, await readOptionalJsonBody(req), label);
}

function openSseStream(res: ServerResponse): ReturnType<typeof setInterval> {
  res.setTimeout(0);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const keepalive = setInterval(() => {
    writeSseComment(res, "keepalive");
  }, SSE_KEEPALIVE_MS);
  keepalive.unref?.();
  return keepalive;
}

export async function startEngineHttpServer(
  engine: Engine,
  options: EngineHttpServerOptions,
): Promise<EngineHttpServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error(`Engine HTTP server only binds to 127.0.0.1 (refused host "${host}")`);
  }
  const requestedPort = options.port ?? 0;

  let closing = false;
  const activeClosers = new Set<() => Promise<void>>();

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const routes: readonly Route[] = [
    route("GET", "/health", ({ res }) => {
      sendJson(res, 200, {
        ok: true,
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        engineVersion: ENGINE_VERSION,
        pid: process.pid,
      });
    }),
    route("POST", "/shutdown", ({ res }) => {
      sendJson(res, 200, { ok: true });
      if (options.onShutdown !== undefined) setImmediate(options.onShutdown);
    }),

    route("GET", "/providers", async ({ res }) => {
      sendJson(res, 200, await engine.listProviders());
    }),
    route("PUT", "/providers/:providerId/auth/api-key", async ({ req, res, params }) => {
      const input = await readBody(req, SetApiKeyRequestSchema, "SetApiKeyRequest");
      sendJson(res, 200, await engine.setProviderApiKey(params.providerId, input));
    }),
    route("DELETE", "/providers/:providerId/auth", async ({ res, params }) => {
      sendJson(res, 200, await engine.logoutProvider(params.providerId));
    }),
    route("POST", "/providers/:providerId/auth/login", async ({ req, res, params }) => {
      const input = await readBody(req, StartLoginRequestSchema, "StartLoginRequest");
      sendJson(res, 201, engine.startProviderLogin(params.providerId, input));
    }),
    route("GET", "/providers/:providerId/auth/login/:sessionId/stream", ({ req, res, params }) => {
      handleLoginStream(req, res, params.providerId, params.sessionId);
    }),
    route(
      "POST",
      "/providers/:providerId/auth/login/:sessionId/input",
      async ({ req, res, params }) => {
        const input = await readBody(req, LoginInputRequestSchema, "LoginInputRequest");
        sendJson(res, 200, engine.submitLoginInput(params.providerId, params.sessionId, input));
      },
    ),
    route(
      "POST",
      "/providers/:providerId/auth/login/:sessionId/cancel",
      async ({ req, res, params }) => {
        await readOptionalJsonBody(req);
        sendJson(res, 200, engine.cancelLoginSession(params.providerId, params.sessionId));
      },
    ),

    route("GET", "/models", async ({ res, url }) => {
      sendJson(res, 200, await engine.listModels(parseModelsQuery(url)));
    }),
    route("POST", "/models/refresh", async ({ req, res }) => {
      const input = await readOptionalBody(req, RefreshModelsRequestSchema, "RefreshModelsRequest");
      sendJson(res, 200, await engine.refreshModels(input));
    }),
    route("GET", "/models/profiles", ({ res }) => {
      sendJson(res, 200, engine.getModelProfiles());
    }),
    route("PUT", "/models/profiles", async ({ req, res }) => {
      const input = await readBody(req, ModelProfilesDocumentSchema, "ModelProfilesDocument");
      sendJson(res, 200, engine.putModelProfiles(input));
    }),

    route("GET", "/mcp", ({ res }) => {
      sendJson(res, 200, engine.getMcpState());
    }),
    route("PUT", "/mcp", async ({ req, res }) => {
      const input = await readBody(req, PutMcpConfigRequestSchema, "PutMcpConfigRequest");
      sendJson(res, 200, await engine.putMcpConfig(input));
    }),
    route("PUT", "/mcp/servers/:serverName", async ({ req, res, params }) => {
      const input = await readBody(req, UpsertMcpServerRequestSchema, "UpsertMcpServerRequest");
      sendJson(res, 200, await engine.upsertMcpServer(params.serverName, input));
    }),
    route("DELETE", "/mcp/servers/:serverName", async ({ res, params }) => {
      sendJson(res, 200, await engine.deleteMcpServer(params.serverName));
    }),
    route("POST", "/mcp/reconnect", async ({ req, res }) => {
      const input = await readOptionalBody(req, ReconnectMcpRequestSchema, "ReconnectMcpRequest");
      sendJson(res, 200, await engine.reconnectMcp(input));
    }),

    route("GET", "/settings", ({ res }) => {
      sendJson(res, 200, engine.getSettings());
    }),
    route("PATCH", "/settings", async ({ req, res }) => {
      const input = await readBody(req, EngineSettingsSchema, "EngineSettings");
      sendJson(res, 200, await engine.patchSettings(input));
    }),
    route("PUT", "/settings", async ({ req, res }) => {
      const input = await readBody(req, EngineSettingsSchema, "EngineSettings");
      sendJson(res, 200, await engine.putSettings(input));
    }),
    route("GET", "/config/export", async ({ res }) => {
      sendJson(res, 200, await engine.exportConfig());
    }),
    route("POST", "/config/import", async ({ req, res }) => {
      const input = await readBody(req, ConfigBundleSchema, "ConfigBundle");
      sendJson(res, 200, await engine.importConfig(input));
    }),

    route("GET", "/projects", ({ res }) => {
      sendJson(res, 200, { projects: engine.listProjects() });
    }),
    route("POST", "/projects", async ({ req, res }) => {
      const input = await readBody(req, CreateProjectRequestSchema, "CreateProjectRequest");
      sendJson(res, 201, { project: engine.createProject(input) });
    }),
    route("GET", "/projects/:projectId", ({ res, params }) => {
      sendJson(res, 200, { project: engine.getProject(params.projectId) });
    }),
    route("PATCH", "/projects/:projectId", async ({ req, res, params }) => {
      const input = await readBody(req, UpdateProjectRequestSchema, "UpdateProjectRequest");
      sendJson(res, 200, await engine.updateProject(params.projectId, input));
    }),
    route("DELETE", "/projects/:projectId", async ({ res, params }) => {
      sendJson(res, 200, await engine.deleteProject(params.projectId));
    }),
    route("GET", "/projects/:projectId/memory", ({ res, params }) => {
      sendJson(res, 200, engine.getProjectMemory(params.projectId));
    }),
    route("PUT", "/projects/:projectId/memory", async ({ req, res, params }) => {
      const input = await readBody(req, PutProjectMemoryRequestSchema, "PutProjectMemoryRequest");
      sendJson(res, 200, engine.putProjectMemory(params.projectId, input));
    }),
    route("GET", "/projects/:projectId/usage", async ({ res, params }) => {
      sendJson(res, 200, await engine.getProjectUsage(params.projectId));
    }),
    route("GET", "/projects/:projectId/board", async ({ res, params }) => {
      sendJson(res, 200, await engine.getBoard(params.projectId));
    }),
    route("GET", "/projects/:projectId/board/stream", async ({ req, res, params }) => {
      await handleBoardStream(req, res, params.projectId);
    }),

    route(
      "POST",
      "/projects/:projectId/conversations/:ref/messages",
      async ({ req, res, params }) => {
        const input = await readBody(req, SendMessageRequestSchema, "SendMessageRequest");
        sendJson(res, 202, await engine.sendMessage(params.projectId, params.ref, input));
      },
    ),
    route(
      "GET",
      "/projects/:projectId/conversations/:ref/entries",
      async ({ res, url, params }) => {
        const query = parseEntriesQuery(url);
        sendJson(res, 200, await engine.listEntries(params.projectId, params.ref, query));
      },
    ),
    route("POST", "/projects/:projectId/conversations/:ref/interrupt", async ({ res, params }) => {
      sendJson(res, 200, await engine.interrupt(params.projectId, params.ref));
    }),
    route("POST", "/projects/:projectId/conversations/:ref/retry", async ({ res, params }) => {
      sendJson(res, 202, await engine.retry(params.projectId, params.ref));
    }),
    route(
      "GET",
      "/projects/:projectId/conversations/:ref/stream",
      async ({ req, res, url, params }) => {
        const window = parseWindowParams(url, req);
        await handleConversationStream(req, res, params.projectId, params.ref, window);
      },
    ),
    route(
      "POST",
      "/projects/:projectId/questions/:questionId/answer",
      async ({ req, res, params }) => {
        const input = await readBody(req, AnswerQuestionRequestSchema, "AnswerQuestionRequest");
        const result = await engine.answerQuestion(params.projectId, params.questionId, input);
        sendJson(res, 200, result);
      },
    ),
    route(
      "GET",
      "/projects/:projectId/workers/:workerId/tasks/:taskId",
      async ({ res, url, params }) => {
        const query = parseReadWorkerTaskQuery(url);
        const { projectId, workerId, taskId } = params;
        sendJson(res, 200, await engine.readWorkerTask(projectId, workerId, taskId, query));
      },
    ),
    route(
      "POST",
      "/projects/:projectId/workers/:workerId/tasks/:taskId/kill",
      async ({ res, params }) => {
        const { projectId, workerId, taskId } = params;
        sendJson(res, 200, await engine.killWorkerTask(projectId, workerId, taskId));
      },
    ),
  ];

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!verifyBearerToken(req.headers.authorization, options.token)) {
      sendProblem(
        res,
        401,
        { code: "unauthorized", message: "Missing or invalid bearer token" },
        { "WWW-Authenticate": "Bearer" },
      );
      return;
    }

    if (closing) {
      sendProblem(res, 503, { code: "engine_closed", message: "Engine is closing" });
      return;
    }

    let url: URL;
    let segments: string[];
    try {
      url = new URL(req.url ?? "/", `http://${host}`);
      segments = url.pathname
        .split("/")
        .filter((part) => part.length > 0)
        .map((part) => decodeURIComponent(part));
    } catch (error) {
      sendProblem(res, 400, {
        code: "invalid_url",
        message: "Malformed request URL",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const method = req.method ?? "GET";

    try {
      const candidates = routes.filter((candidate) => matchesPattern(candidate.pattern, segments));
      const matched = candidates.find((candidate) => candidate.method === method);
      if (matched === undefined) {
        if (candidates.length === 0) {
          sendProblem(res, 404, { code: "not_found", message: "Route not found" });
        } else {
          sendMethodNotAllowed(res, method, candidates.map((c) => c.method).join(", "));
        }
        return;
      }
      const params = parsePathParams(matched.pattern, segments);
      await matched.handle({ req, res, url, params });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }
      if (error instanceof EngineError) {
        const extra = error.code === "payload_too_large" ? { Connection: "close" } : undefined;
        sendProblem(res, error.status, error.toProblem(), extra);
        return;
      }
      if (error instanceof SchemaValidationError) {
        sendProblem(res, 400, {
          code: "invalid_request",
          message: error.message,
        });
        return;
      }
      sendProblem(res, 500, {
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handleLoginStream(
    req: IncomingMessage,
    res: ServerResponse,
    providerId: string,
    sessionId: string,
  ): void {
    const buffered: LoginSseFrame[] = [];
    let streamReady = false;
    let ended = false;
    let unsubscribe = () => {};
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let closeForServer = async () => {};

    const finish = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      activeClosers.delete(closeForServer);
      if (keepalive !== undefined) clearInterval(keepalive);
      unsubscribe();
      if (!res.writableEnded && !res.destroyed) res.end();
    };

    const emitFrame = (frame: LoginSseFrame): void => {
      if (ended) return;
      writeSseEvent(res, frame.event, frame.data);
      if (frame.event === "complete" || frame.event === "error") {
        void finish();
      }
    };

    unsubscribe = engine.subscribeLoginSession(providerId, sessionId, (frame) => {
      if (!streamReady) {
        buffered.push(frame);
        return;
      }
      emitFrame(frame);
    });

    if (closing || res.destroyed || req.socket.destroyed) {
      unsubscribe();
      return;
    }

    keepalive = openSseStream(res);

    closeForServer = async () => {
      if (!ended) {
        writeSseEvent(res, "error", { code: "engine_closed", message: "Engine is closing" });
      }
      await finish();
    };
    activeClosers.add(closeForServer);

    res.on("close", () => {
      void finish();
    });

    streamReady = true;
    for (const frame of buffered) {
      emitFrame(frame);
    }
  }

  async function handleBoardStream(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
  ): Promise<void> {
    const releaseStream = engine.acquireStream(projectId);
    try {
      const handle = await engine.openProject(projectId);
      const initial = await handle.board(BACKGROUND_CONTEXT);

      if (closing || res.destroyed || req.socket.destroyed) {
        releaseStream();
        return;
      }

      const keepalive = openSseStream(res);
      let ended = false;
      let lastSignature = JSON.stringify(initial);
      writeSseEvent(res, "board", initial);

      let unsubscribe = () => {};

      const finish = async (reason?: "closed"): Promise<void> => {
        if (ended) return;
        ended = true;
        activeClosers.delete(closeForServer);
        clearInterval(keepalive);
        unsubscribe();
        releaseStream();
        if (reason !== undefined) {
          writeSseEvent(res, "end", { reason });
        }
        if (!res.writableEnded && !res.destroyed) res.end();
      };

      const closeForServer = () => finish("closed");
      activeClosers.add(closeForServer);

      res.on("close", () => {
        void finish();
      });

      unsubscribe = handle.subscribeBoard((board) => {
        if (ended) return;
        const signature = JSON.stringify(board);
        if (signature === lastSignature) return;
        lastSignature = signature;
        writeSseEvent(res, "board", board);
      });
    } catch (error) {
      releaseStream();
      throw error;
    }
  }

  async function handleConversationStream(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    ref: ConversationRef,
    window: ConversationWindow | undefined,
  ): Promise<void> {
    const releaseStream = engine.acquireStream(projectId);
    try {
      const watchAbort = new AbortController();
      const watchContext = withAbortSignal(watchAbort.signal, BACKGROUND_CONTEXT);
      const watch = await engine.watchConversation(projectId, ref, watchContext, window);

      if (closing || res.destroyed || req.socket.destroyed) {
        watchAbort.abort();
        await watch.stop().catch(() => undefined);
        releaseStream();
        return;
      }

      const keepalive = openSseStream(res);
      let ended = false;

      const finish = async (
        endPayload?: {
          readonly reason: "ended" | "aborted" | "closed" | "failed";
          readonly message?: string;
        },
        stopWatch = true,
      ): Promise<void> => {
        if (ended) return;
        ended = true;
        activeClosers.delete(closeForServer);
        clearInterval(keepalive);
        releaseStream();
        if (endPayload !== undefined) {
          writeSseEvent(res, "end", endPayload);
        }
        if (!res.writableEnded && !res.destroyed) res.end();
        if (stopWatch) {
          watchAbort.abort();
          await watch.stop().catch(() => undefined);
        }
      };

      const closeForServer = () => finish({ reason: "closed" }, true);
      activeClosers.add(closeForServer);

      res.on("close", () => {
        void finish(undefined, true);
      });

      const initialId = watch.value.entries.at(-1)?.id ?? watch.value.before;
      writeSseEvent(res, "snapshot", { view: watch.value }, initialId);

      watch.start(async (call) => {
        if (ended) return;
        if (call.kind === "value") {
          const entryId = call.value.entries.at(-1)?.id ?? call.value.before;
          writeSseEvent(res, "patch", { ops: call.ops, retired: call.retired }, entryId);
        } else {
          const message = call.error instanceof Error ? call.error.message : String(call.error);
          writeSseEvent(res, "failed", { message: message || "Conversation watch failed" });
        }
      });

      void watch.closed.then((watchEnd) => {
        if (ended) return;
        if (closing) {
          void finish({ reason: "closed" }, false);
          return;
        }
        switch (watchEnd.kind) {
          case "ended":
            void finish({ reason: "ended" }, false);
            break;
          case "aborted":
          case "stopped":
            void finish({ reason: "aborted" }, false);
            break;
          case "failed":
          case "listener_error": {
            const message =
              watchEnd.error instanceof Error ? watchEnd.error.message : String(watchEnd.error);
            void finish({ reason: "failed", ...(message ? { message } : {}) }, false);
            break;
          }
        }
      });
    } catch (error) {
      releaseStream();
      throw error;
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Expected TCP address for Engine HTTP server");
  }
  const boundPort = address.port;
  const url = `http://${host}:${boundPort}`;

  let closePromise: Promise<void> | undefined;
  return {
    server,
    host,
    port: boundPort,
    url,
    close: () => {
      closePromise ??= (async () => {
        closing = true;
        await Promise.allSettled([...activeClosers].map((closeStream) => closeStream()));
        server.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error !== undefined && error !== null) reject(error);
            else resolve();
          });
        });
      })();
      return closePromise;
    },
  };
}
