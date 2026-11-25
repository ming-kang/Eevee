import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationWindow, EntryId } from "@earendil-works/pi-durable";
import { compile } from "@earendil-works/pi-schema";
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
  type WorkerId,
  WorkerIdSchema,
} from "@eevee/protocol";
import { verifyBearerToken } from "./auth.ts";
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "./constants.ts";
import { type Engine, EngineError, type ListEntriesParams, type LoginSseFrame } from "./engine.ts";

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const SSE_KEEPALIVE_MS = 20_000;

const projectIdValidator = compile(ProjectIdSchema);
const conversationRefValidator = compile(ConversationRefSchema);
const questionIdValidator = compile(QuestionIdSchema);
const workerIdValidator = compile(WorkerIdSchema);
const createProjectValidator = compile(CreateProjectRequestSchema);
const updateProjectValidator = compile(UpdateProjectRequestSchema);
const putProjectMemoryValidator = compile(PutProjectMemoryRequestSchema);
const sendMessageValidator = compile(SendMessageRequestSchema);
const answerQuestionValidator = compile(AnswerQuestionRequestSchema);
const scanOrderValidator = compile(ScanOrderSchema);
const taskReadModeValidator = compile(TaskReadModeSchema);
const setApiKeyValidator = compile(SetApiKeyRequestSchema);
const startLoginValidator = compile(StartLoginRequestSchema);
const loginInputValidator = compile(LoginInputRequestSchema);
const refreshModelsValidator = compile(RefreshModelsRequestSchema);
const modelProfilesValidator = compile(ModelProfilesDocumentSchema);
const putMcpConfigValidator = compile(PutMcpConfigRequestSchema);
const upsertMcpServerValidator = compile(UpsertMcpServerRequestSchema);
const reconnectMcpValidator = compile(ReconnectMcpRequestSchema);
const engineSettingsValidator = compile(EngineSettingsSchema);
const configBundleValidator = compile(ConfigBundleSchema);

export type EngineHttpServerOptions = {
  readonly host?: string;
  readonly port?: number;
  readonly token: string;
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
    const checked = scanOrderValidator.validate(orderParam);
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
    const checked = taskReadModeValidator.validate(modeParam);
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

function parseProjectIdSegment(raw: string): string {
  return parseWithSchema(projectIdValidator, raw, "projectId");
}

function parseConversationRefSegment(raw: string): ConversationRef {
  return parseWithSchema(conversationRefValidator, raw, "conversationRef");
}

function parseQuestionIdSegment(raw: string): QuestionId {
  return parseWithSchema(questionIdValidator, raw, "questionId");
}

function parseWorkerIdSegment(raw: string): WorkerId {
  return parseWithSchema(workerIdValidator, raw, "workerId");
}

function parseNonEmptySegment(raw: string, label: string): string {
  if (raw.trim().length === 0) {
    throw new EngineError(400, "invalid_request", `${label} must not be empty`);
  }
  return raw;
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
      if (segments.length === 1 && segments[0] === "health") {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        sendJson(res, 200, {
          ok: true,
          protocolVersion: ENGINE_PROTOCOL_VERSION,
          engineVersion: ENGINE_VERSION,
          pid: process.pid,
        });
        return;
      }

      if (segments.length === 1 && segments[0] === "providers") {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        sendJson(res, 200, await engine.listProviders());
        return;
      }

      if (
        segments.length === 4 &&
        segments[0] === "providers" &&
        segments[2] === "auth" &&
        segments[3] === "api-key"
      ) {
        if (method !== "PUT") {
          sendMethodNotAllowed(res, method, "PUT");
          return;
        }
        const providerId = parseNonEmptySegment(segments[1] ?? "", "providerId");
        const rawBody = await readJsonBody(req);
        const input = parseWithSchema(setApiKeyValidator, rawBody, "SetApiKeyRequest");
        sendJson(res, 200, await engine.setProviderApiKey(providerId, input));
        return;
      }

      if (segments.length === 3 && segments[0] === "providers" && segments[2] === "auth") {
        if (method !== "DELETE") {
          sendMethodNotAllowed(res, method, "DELETE");
          return;
        }
        const providerId = parseNonEmptySegment(segments[1] ?? "", "providerId");
        sendJson(res, 200, await engine.logoutProvider(providerId));
        return;
      }

      if (
        segments.length === 4 &&
        segments[0] === "providers" &&
        segments[2] === "auth" &&
        segments[3] === "login"
      ) {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const providerId = parseNonEmptySegment(segments[1] ?? "", "providerId");
        const rawBody = await readJsonBody(req);
        const input = parseWithSchema(startLoginValidator, rawBody, "StartLoginRequest");
        sendJson(res, 201, engine.startProviderLogin(providerId, input));
        return;
      }

      if (
        segments.length === 6 &&
        segments[0] === "providers" &&
        segments[2] === "auth" &&
        segments[3] === "login" &&
        segments[5] === "stream"
      ) {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        const providerId = parseNonEmptySegment(segments[1] ?? "", "providerId");
        const sessionId = parseNonEmptySegment(segments[4] ?? "", "sessionId");
        handleLoginStream(req, res, providerId, sessionId);
        return;
      }

      if (
        segments.length === 6 &&
        segments[0] === "providers" &&
        segments[2] === "auth" &&
        segments[3] === "login" &&
        segments[5] === "input"
      ) {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const providerId = parseNonEmptySegment(segments[1] ?? "", "providerId");
        const sessionId = parseNonEmptySegment(segments[4] ?? "", "sessionId");
        const rawBody = await readJsonBody(req);
        const input = parseWithSchema(loginInputValidator, rawBody, "LoginInputRequest");
        sendJson(res, 200, engine.submitLoginInput(providerId, sessionId, input));
        return;
      }

      if (
        segments.length === 6 &&
        segments[0] === "providers" &&
        segments[2] === "auth" &&
        segments[3] === "login" &&
        segments[5] === "cancel"
      ) {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const providerId = parseNonEmptySegment(segments[1] ?? "", "providerId");
        const sessionId = parseNonEmptySegment(segments[4] ?? "", "sessionId");
        await readOptionalJsonBody(req);
        sendJson(res, 200, engine.cancelLoginSession(providerId, sessionId));
        return;
      }

      if (segments.length === 1 && segments[0] === "models") {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        const query = parseModelsQuery(url);
        sendJson(res, 200, await engine.listModels(query));
        return;
      }

      if (segments.length === 2 && segments[0] === "models" && segments[1] === "refresh") {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const rawBody = await readOptionalJsonBody(req);
        const input = parseWithSchema(refreshModelsValidator, rawBody, "RefreshModelsRequest");
        sendJson(res, 200, await engine.refreshModels(input));
        return;
      }

      if (segments.length === 2 && segments[0] === "models" && segments[1] === "profiles") {
        if (method === "GET") {
          sendJson(res, 200, engine.getModelProfiles());
          return;
        }
        if (method === "PUT") {
          const rawBody = await readJsonBody(req);
          const input = parseWithSchema(modelProfilesValidator, rawBody, "ModelProfilesDocument");
          sendJson(res, 200, engine.putModelProfiles(input));
          return;
        }
        sendMethodNotAllowed(res, method, "GET, PUT");
        return;
      }

      if (segments.length === 1 && segments[0] === "mcp") {
        if (method === "GET") {
          sendJson(res, 200, engine.getMcpState());
          return;
        }
        if (method === "PUT") {
          const rawBody = await readJsonBody(req);
          const input = parseWithSchema(putMcpConfigValidator, rawBody, "PutMcpConfigRequest");
          sendJson(res, 200, await engine.putMcpConfig(input));
          return;
        }
        sendMethodNotAllowed(res, method, "GET, PUT");
        return;
      }

      if (segments.length === 3 && segments[0] === "mcp" && segments[1] === "servers") {
        const serverName = parseNonEmptySegment(segments[2] ?? "", "serverName");
        if (method === "PUT") {
          const rawBody = await readJsonBody(req);
          const input = parseWithSchema(
            upsertMcpServerValidator,
            rawBody,
            "UpsertMcpServerRequest",
          );
          sendJson(res, 200, await engine.upsertMcpServer(serverName, input));
          return;
        }
        if (method === "DELETE") {
          sendJson(res, 200, await engine.deleteMcpServer(serverName));
          return;
        }
        sendMethodNotAllowed(res, method, "PUT, DELETE");
        return;
      }

      if (segments.length === 2 && segments[0] === "mcp" && segments[1] === "reconnect") {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const rawBody = await readOptionalJsonBody(req);
        const input = parseWithSchema(reconnectMcpValidator, rawBody, "ReconnectMcpRequest");
        sendJson(res, 200, await engine.reconnectMcp(input));
        return;
      }

      if (segments.length === 1 && segments[0] === "settings") {
        if (method === "GET") {
          sendJson(res, 200, engine.getSettings());
          return;
        }
        if (method === "PATCH") {
          const rawBody = await readJsonBody(req);
          const input = parseWithSchema(engineSettingsValidator, rawBody, "EngineSettings");
          sendJson(res, 200, await engine.patchSettings(input));
          return;
        }
        if (method === "PUT") {
          const rawBody = await readJsonBody(req);
          const input = parseWithSchema(engineSettingsValidator, rawBody, "EngineSettings");
          sendJson(res, 200, await engine.putSettings(input));
          return;
        }
        sendMethodNotAllowed(res, method, "GET, PATCH, PUT");
        return;
      }

      if (segments.length === 2 && segments[0] === "config" && segments[1] === "export") {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        sendJson(res, 200, await engine.exportConfig());
        return;
      }

      if (segments.length === 2 && segments[0] === "config" && segments[1] === "import") {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const rawBody = await readJsonBody(req);
        const input = parseWithSchema(configBundleValidator, rawBody, "ConfigBundle");
        sendJson(res, 200, await engine.importConfig(input));
        return;
      }

      if (segments.length === 1 && segments[0] === "projects") {
        if (method === "GET") {
          sendJson(res, 200, { projects: engine.listProjects() });
          return;
        }
        if (method === "POST") {
          const rawBody = await readJsonBody(req);
          const input = parseWithSchema(createProjectValidator, rawBody, "CreateProjectRequest");
          const project = engine.createProject(input);
          sendJson(res, 201, { project });
          return;
        }
        sendMethodNotAllowed(res, method, "GET, POST");
        return;
      }

      if (segments.length === 2 && segments[0] === "projects") {
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        if (method === "GET") {
          const project = engine.getProject(projectId);
          sendJson(res, 200, { project });
          return;
        }
        if (method === "PATCH") {
          const rawBody = await readJsonBody(req);
          const input = parseWithSchema(updateProjectValidator, rawBody, "UpdateProjectRequest");
          sendJson(res, 200, await engine.updateProject(projectId, input));
          return;
        }
        if (method === "DELETE") {
          sendJson(res, 200, await engine.deleteProject(projectId));
          return;
        }
        sendMethodNotAllowed(res, method, "GET, PATCH, DELETE");
        return;
      }

      if (segments.length === 3 && segments[0] === "projects" && segments[2] === "memory") {
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        if (method === "GET") {
          sendJson(res, 200, engine.getProjectMemory(projectId));
          return;
        }
        if (method === "PUT") {
          const rawBody = await readJsonBody(req);
          const input = parseWithSchema(
            putProjectMemoryValidator,
            rawBody,
            "PutProjectMemoryRequest",
          );
          sendJson(res, 200, engine.putProjectMemory(projectId, input));
          return;
        }
        sendMethodNotAllowed(res, method, "GET, PUT");
        return;
      }

      if (segments.length === 3 && segments[0] === "projects" && segments[2] === "usage") {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        sendJson(res, 200, await engine.getProjectUsage(projectId));
        return;
      }

      if (segments.length === 3 && segments[0] === "projects" && segments[2] === "board") {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        const board = await engine.getBoard(projectId);
        sendJson(res, 200, board);
        return;
      }

      if (
        segments.length === 4 &&
        segments[0] === "projects" &&
        segments[2] === "board" &&
        segments[3] === "stream"
      ) {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        await handleBoardStream(req, res, projectId);
        return;
      }

      if (
        segments.length === 5 &&
        segments[0] === "projects" &&
        segments[2] === "conversations" &&
        segments[4] === "messages"
      ) {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        const ref = parseConversationRefSegment(segments[3] ?? "");
        const rawBody = await readJsonBody(req);
        const input = parseWithSchema(sendMessageValidator, rawBody, "SendMessageRequest");
        const result = await engine.sendMessage(projectId, ref, input);
        sendJson(res, 202, result);
        return;
      }

      if (
        segments.length === 5 &&
        segments[0] === "projects" &&
        segments[2] === "conversations" &&
        segments[4] === "entries"
      ) {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        const ref = parseConversationRefSegment(segments[3] ?? "");
        const query = parseEntriesQuery(url);
        const result = await engine.listEntries(projectId, ref, query);
        sendJson(res, 200, result);
        return;
      }

      if (
        segments.length === 5 &&
        segments[0] === "projects" &&
        segments[2] === "conversations" &&
        segments[4] === "interrupt"
      ) {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        const ref = parseConversationRefSegment(segments[3] ?? "");
        const result = await engine.interrupt(projectId, ref);
        sendJson(res, 200, result);
        return;
      }

      if (
        segments.length === 5 &&
        segments[0] === "projects" &&
        segments[2] === "conversations" &&
        segments[4] === "retry"
      ) {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        const ref = parseConversationRefSegment(segments[3] ?? "");
        const result = await engine.retry(projectId, ref);
        sendJson(res, 202, result);
        return;
      }

      if (
        segments.length === 5 &&
        segments[0] === "projects" &&
        segments[2] === "conversations" &&
        segments[4] === "stream"
      ) {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        const ref = parseConversationRefSegment(segments[3] ?? "");
        const window = parseWindowParams(url, req);
        await handleConversationStream(req, res, projectId, ref, window);
        return;
      }

      if (
        segments.length === 5 &&
        segments[0] === "projects" &&
        segments[2] === "questions" &&
        segments[4] === "answer"
      ) {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        const questionId = parseQuestionIdSegment(segments[3] ?? "");
        const rawBody = await readJsonBody(req);
        const input = parseWithSchema(answerQuestionValidator, rawBody, "AnswerQuestionRequest");
        const result = await engine.answerQuestion(projectId, questionId, input);
        sendJson(res, 200, result);
        return;
      }

      if (
        segments.length === 6 &&
        segments[0] === "projects" &&
        segments[2] === "workers" &&
        segments[4] === "tasks"
      ) {
        if (method !== "GET") {
          sendMethodNotAllowed(res, method, "GET");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        const workerId = parseWorkerIdSegment(segments[3] ?? "");
        const taskId = parseNonEmptySegment(segments[5] ?? "", "taskId");
        const options = parseReadWorkerTaskQuery(url);
        const result = await engine.readWorkerTask(projectId, workerId, taskId, options);
        sendJson(res, 200, result);
        return;
      }

      if (
        segments.length === 7 &&
        segments[0] === "projects" &&
        segments[2] === "workers" &&
        segments[4] === "tasks" &&
        segments[6] === "kill"
      ) {
        if (method !== "POST") {
          sendMethodNotAllowed(res, method, "POST");
          return;
        }
        const projectId = parseProjectIdSegment(segments[1] ?? "");
        const workerId = parseWorkerIdSegment(segments[3] ?? "");
        const taskId = parseNonEmptySegment(segments[5] ?? "", "taskId");
        const result = await engine.killWorkerTask(projectId, workerId, taskId);
        sendJson(res, 200, result);
        return;
      }

      sendProblem(res, 404, { code: "not_found", message: "Route not found" });
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

    res.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    keepalive = setInterval(() => {
      writeSseComment(res, "keepalive");
    }, SSE_KEEPALIVE_MS);
    keepalive.unref?.();

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

      res.setTimeout(0);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      let ended = false;
      let lastSignature = JSON.stringify(initial);
      writeSseEvent(res, "board", initial);

      let unsubscribe = () => {};
      const keepalive = setInterval(() => {
        writeSseComment(res, "keepalive");
      }, SSE_KEEPALIVE_MS);
      keepalive.unref?.();

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

      res.setTimeout(0);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      let ended = false;
      const keepalive = setInterval(() => {
        writeSseComment(res, "keepalive");
      }, SSE_KEEPALIVE_MS);
      keepalive.unref?.();

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
