import type { IncomingMessage, ServerResponse } from "node:http";
import type { Static } from "@earendil-works/pi-schema";
import {
  AnswerQuestionRequestSchema,
  BuiltinModelMatchRequestSchema,
  ConfigBundleSchema,
  CreateProjectRequestSchema,
  EngineSettingsSchema,
  ImportProviderModelsRequestSchema,
  LoginInputRequestSchema,
  McpOAuthInputRequestSchema,
  ModelProfilesDocumentSchema,
  ProbeProviderRequestSchema,
  PutMcpConfigRequestSchema,
  PutProjectMemoryRequestSchema,
  PutSkillsPolicyRequestSchema,
  ReconnectMcpRequestSchema,
  RefreshModelsRequestSchema,
  SendMessageRequestSchema,
  SetApiKeyRequestSchema,
  SmokeTestModelRequestSchema,
  StartLoginRequestSchema,
  UpdateProjectRequestSchema,
  UpsertMcpServerRequestSchema,
  UpsertProviderModelRequestSchema,
  UpsertProviderRequestSchema,
} from "@eevee/protocol";
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "./constants.ts";
import type { Engine } from "./engine.ts";
import {
  parseEntriesQuery,
  parseListWorkerTasksQuery,
  parseModelsQuery,
  parseReadWorkerTaskQuery,
  parseStreamWorkerTaskQuery,
  parseWindowParams,
  type Route,
  readBody,
  readOptionalBody,
  readOptionalJsonBody,
  route,
  sendJson,
} from "./http-io.ts";
import type { SseStreamHandlers } from "./http-sse.ts";
import type { WebAuthManager } from "./web-auth.ts";

async function withDisconnectSignal(
  req: IncomingMessage,
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const disconnect = () => {
    if (req.aborted || req.socket.destroyed) controller.abort(new Error("Client disconnected"));
  };
  req.on("close", disconnect);
  try {
    await run(controller.signal);
  } finally {
    req.off("close", disconnect);
  }
}

type ScopedMcpHandlers<TScope> = {
  readonly getState: (scope: TScope) => unknown;
  readonly putConfig: (scope: TScope, input: Static<typeof PutMcpConfigRequestSchema>) => unknown;
  readonly reconnect: (scope: TScope, input: Static<typeof ReconnectMcpRequestSchema>) => unknown;
  readonly upsertServer: (
    scope: TScope,
    serverName: string,
    input: Static<typeof UpsertMcpServerRequestSchema>,
  ) => unknown;
  readonly deleteServer: (scope: TScope, serverName: string) => unknown;
  readonly getLogs: (scope: TScope, serverName: string) => unknown;
  readonly startOAuth: (scope: TScope, serverName: string) => unknown;
  readonly streamOAuth: (
    req: IncomingMessage,
    res: ServerResponse,
    scope: TScope,
    serverName: string,
    sessionId: string,
  ) => void;
  readonly submitOAuthInput: (
    scope: TScope,
    serverName: string,
    sessionId: string,
    input: Static<typeof McpOAuthInputRequestSchema>,
  ) => unknown;
  readonly cancelOAuth: (scope: TScope, serverName: string, sessionId: string) => unknown;
  readonly logoutOAuth: (scope: TScope, serverName: string) => unknown;
};

type ScopedMcpParams = {
  readonly projectId?: string;
  readonly serverName: string;
  readonly sessionId: string;
};

function createScopedMcpRoutes<Prefix extends "/mcp" | "/projects/:projectId/mcp">(
  prefix: Prefix,
  handlers: ScopedMcpHandlers<Prefix extends "/mcp" ? undefined : string>,
): readonly Route[] {
  type TScope = Prefix extends "/mcp" ? undefined : string;
  const scopeOf = (params: { readonly projectId?: string }) =>
    (prefix === "/mcp" ? undefined : params.projectId) as TScope;

  const mcpRoute = (
    method: string,
    suffix: string,
    handle: (ctx: {
      readonly req: IncomingMessage;
      readonly res: ServerResponse;
      readonly scope: TScope;
      readonly params: ScopedMcpParams;
    }) => Promise<void> | void,
  ): Route =>
    route(
      method,
      `${prefix}${suffix}` as `/projects/:projectId/mcp/servers/:serverName/oauth/login/:sessionId/stream`,
      ({ req, res, params }) => handle({ req, res, scope: scopeOf(params), params }),
    );

  return [
    mcpRoute("GET", "", ({ res, scope }) => {
      sendJson(res, 200, handlers.getState(scope));
    }),
    mcpRoute("PUT", "", async ({ req, res, scope }) => {
      const input = await readBody(req, PutMcpConfigRequestSchema, "PutMcpConfigRequest");
      sendJson(res, 200, await handlers.putConfig(scope, input));
    }),
    mcpRoute("POST", "/reconnect", async ({ req, res, scope }) => {
      const input = await readOptionalBody(req, ReconnectMcpRequestSchema, "ReconnectMcpRequest");
      sendJson(res, 200, await handlers.reconnect(scope, input));
    }),
    mcpRoute("PUT", "/servers/:serverName", async ({ req, res, scope, params }) => {
      const input = await readBody(req, UpsertMcpServerRequestSchema, "UpsertMcpServerRequest");
      sendJson(res, 200, await handlers.upsertServer(scope, params.serverName, input));
    }),
    mcpRoute("DELETE", "/servers/:serverName", async ({ res, scope, params }) => {
      sendJson(res, 200, await handlers.deleteServer(scope, params.serverName));
    }),
    mcpRoute("GET", "/servers/:serverName/logs", ({ res, scope, params }) => {
      sendJson(res, 200, handlers.getLogs(scope, params.serverName));
    }),
    mcpRoute("POST", "/servers/:serverName/oauth/login", async ({ req, res, scope, params }) => {
      await readOptionalJsonBody(req);
      sendJson(res, 201, await handlers.startOAuth(scope, params.serverName));
    }),
    mcpRoute(
      "GET",
      "/servers/:serverName/oauth/login/:sessionId/stream",
      ({ req, res, scope, params }) => {
        handlers.streamOAuth(req, res, scope, params.serverName, params.sessionId);
      },
    ),
    mcpRoute(
      "POST",
      "/servers/:serverName/oauth/login/:sessionId/input",
      async ({ req, res, scope, params }) => {
        const input = await readBody(req, McpOAuthInputRequestSchema, "McpOAuthInputRequest");
        sendJson(
          res,
          200,
          handlers.submitOAuthInput(scope, params.serverName, params.sessionId, input),
        );
      },
    ),
    mcpRoute(
      "POST",
      "/servers/:serverName/oauth/login/:sessionId/cancel",
      async ({ req, res, scope, params }) => {
        await readOptionalJsonBody(req);
        sendJson(res, 200, handlers.cancelOAuth(scope, params.serverName, params.sessionId));
      },
    ),
    mcpRoute("DELETE", "/servers/:serverName/oauth", async ({ res, scope, params }) => {
      sendJson(res, 200, await handlers.logoutOAuth(scope, params.serverName));
    }),
  ];
}

export type EngineRoutesOptions = {
  readonly onShutdown?: () => void;
  readonly streams: SseStreamHandlers;
  readonly webAuth: WebAuthManager;
};

export function createEngineRoutes(engine: Engine, options: EngineRoutesOptions): readonly Route[] {
  const { streams } = options;

  const systemRoutes: readonly Route[] = [
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
    route("POST", "/auth/web-ticket", async ({ req, res }) => {
      await readOptionalJsonBody(req);
      sendJson(res, 201, options.webAuth.issueTicket());
    }),
  ];

  const providerRoutes: readonly Route[] = [
    route("GET", "/providers", async ({ res }) => {
      sendJson(res, 200, await engine.listProviders());
    }),
    route("GET", "/providers/catalog", async ({ res }) => {
      sendJson(res, 200, await engine.getProviderCatalog());
    }),
    route("POST", "/providers/probe", async ({ req, res }) => {
      await withDisconnectSignal(req, async (signal) => {
        const input = await readBody(req, ProbeProviderRequestSchema, "ProbeProviderRequest");
        sendJson(res, 200, await engine.probeDraftProvider(input, signal));
      });
    }),
    route("POST", "/providers", async ({ req, res }) => {
      const input = await readBody(req, UpsertProviderRequestSchema, "UpsertProviderRequest");
      sendJson(res, 201, await engine.createProvider(input));
    }),
    route("GET", "/providers/:providerId", async ({ res, params }) => {
      sendJson(res, 200, await engine.getProviderDetail(params.providerId));
    }),
    route("PATCH", "/providers/:providerId", async ({ req, res, params }) => {
      const input = await readBody(req, UpsertProviderRequestSchema, "UpsertProviderRequest");
      sendJson(res, 200, await engine.updateProvider(params.providerId, input));
    }),
    route("DELETE", "/providers/:providerId", async ({ res, params }) => {
      sendJson(res, 200, await engine.deleteProvider(params.providerId));
    }),
    route("POST", "/providers/:providerId/models", async ({ req, res, params }) => {
      const input = await readBody(
        req,
        UpsertProviderModelRequestSchema,
        "UpsertProviderModelRequest",
      );
      sendJson(res, 201, await engine.createProviderModel(params.providerId, input));
    }),
    route("POST", "/providers/:providerId/models/import", async ({ req, res, params }) => {
      const input = await readBody(
        req,
        ImportProviderModelsRequestSchema,
        "ImportProviderModelsRequest",
      );
      sendJson(res, 200, await engine.importProviderModels(params.providerId, input));
    }),
    route("PATCH", "/providers/:providerId/models/:modelId", async ({ req, res, params }) => {
      const input = await readBody(
        req,
        UpsertProviderModelRequestSchema,
        "UpsertProviderModelRequest",
      );
      sendJson(
        res,
        200,
        await engine.updateProviderModel(params.providerId, params.modelId, input),
      );
    }),
    route("DELETE", "/providers/:providerId/models/:modelId", async ({ res, params }) => {
      sendJson(res, 200, await engine.deleteProviderModel(params.providerId, params.modelId));
    }),
    route("POST", "/providers/:providerId/probe", async ({ req, res, params }) => {
      await withDisconnectSignal(req, async (signal) => {
        const input = await readOptionalBody(
          req,
          ProbeProviderRequestSchema,
          "ProbeProviderRequest",
        );
        sendJson(res, 200, await engine.probeProvider(params.providerId, input, signal));
      });
    }),
    route(
      "POST",
      "/providers/:providerId/models/:modelId/builtin-match",
      async ({ req, res, params }) => {
        const input = await readOptionalBody(
          req,
          BuiltinModelMatchRequestSchema,
          "BuiltinModelMatchRequest",
        );
        sendJson(
          res,
          200,
          await engine.matchBuiltinModel(params.providerId, params.modelId, input),
        );
      },
    ),
    route("POST", "/providers/:providerId/models/:modelId/test", async ({ req, res, params }) => {
      await withDisconnectSignal(req, async (signal) => {
        const input = await readOptionalBody(
          req,
          SmokeTestModelRequestSchema,
          "SmokeTestModelRequest",
        );
        sendJson(
          res,
          200,
          await engine.testProviderModel(params.providerId, params.modelId, input, signal),
        );
      });
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
      streams.handleLoginStream(req, res, params.providerId, params.sessionId);
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
  ];

  const modelRoutes: readonly Route[] = [
    route("GET", "/models", async ({ res, url }) => {
      sendJson(res, 200, await engine.listModels(parseModelsQuery(url)));
    }),
    route("POST", "/models/refresh", async ({ req, res }) => {
      const input = await readOptionalBody(req, RefreshModelsRequestSchema, "RefreshModelsRequest");
      sendJson(res, 200, await engine.refreshModels(input));
    }),
    route("POST", "/models/reload", async ({ req, res }) => {
      await readOptionalJsonBody(req);
      sendJson(res, 200, await engine.reloadModels());
    }),
    route("GET", "/models/profiles", ({ res }) => {
      sendJson(res, 200, engine.getModelProfiles());
    }),
    route("PUT", "/models/profiles", async ({ req, res }) => {
      const input = await readBody(req, ModelProfilesDocumentSchema, "ModelProfilesDocument");
      sendJson(res, 200, engine.putModelProfiles(input));
    }),
  ];

  const skillsRoutes: readonly Route[] = [
    route("GET", "/skills", async ({ res }) => {
      sendJson(res, 200, await engine.listSkills());
    }),
    route("PUT", "/skills/policy", async ({ req, res }) => {
      const input = await readBody(req, PutSkillsPolicyRequestSchema, "PutSkillsPolicyRequest");
      sendJson(res, 200, await engine.putSkillsPolicy(input));
    }),
  ];

  const mcpRoutes: readonly Route[] = createScopedMcpRoutes("/mcp", {
    getState: () => engine.getMcpState(),
    putConfig: (_, input) => engine.putMcpConfig(input),
    reconnect: (_, input) => engine.reconnectMcp(input),
    upsertServer: (_, serverName, input) => engine.upsertMcpServer(serverName, input),
    deleteServer: (_, serverName) => engine.deleteMcpServer(serverName),
    getLogs: (_, serverName) => engine.getMcpLogs(serverName),
    startOAuth: (_, serverName) => engine.startMcpOAuth(serverName),
    streamOAuth: (req, res, _, serverName, sessionId) =>
      streams.handleMcpOAuthStream(req, res, serverName, sessionId),
    submitOAuthInput: (_, serverName, sessionId, input) =>
      engine.submitMcpOAuthInput(serverName, sessionId, input),
    cancelOAuth: (_, serverName, sessionId) => engine.cancelMcpOAuth(serverName, sessionId),
    logoutOAuth: (_, serverName) => engine.logoutMcpOAuth(serverName),
  });

  const settingsRoutes: readonly Route[] = [
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
  ];

  const projectRoutes: readonly Route[] = [
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
    route("GET", "/projects/:projectId/skills", async ({ res, params }) => {
      sendJson(res, 200, await engine.listProjectSkills(params.projectId));
    }),
    route("PUT", "/projects/:projectId/skills/policy", async ({ req, res, params }) => {
      const input = await readBody(req, PutSkillsPolicyRequestSchema, "PutSkillsPolicyRequest");
      sendJson(res, 200, await engine.putProjectSkillsPolicy(params.projectId, input));
    }),
    ...createScopedMcpRoutes("/projects/:projectId/mcp", {
      getState: (projectId) => engine.getProjectMcpState(projectId),
      putConfig: (projectId, input) => engine.putProjectMcpConfig(projectId, input),
      reconnect: (projectId, input) => engine.reconnectProjectMcp(projectId, input),
      upsertServer: (projectId, serverName, input) =>
        engine.upsertProjectMcpServer(projectId, serverName, input),
      deleteServer: (projectId, serverName) => engine.deleteProjectMcpServer(projectId, serverName),
      getLogs: (projectId, serverName) => engine.getProjectMcpLogs(projectId, serverName),
      startOAuth: (projectId, serverName) => engine.startProjectMcpOAuth(projectId, serverName),
      streamOAuth: (req, res, projectId, serverName, sessionId) =>
        streams.handleProjectMcpOAuthStream(req, res, projectId, serverName, sessionId),
      submitOAuthInput: (projectId, serverName, sessionId, input) =>
        engine.submitProjectMcpOAuthInput(projectId, serverName, sessionId, input),
      cancelOAuth: (projectId, serverName, sessionId) =>
        engine.cancelProjectMcpOAuth(projectId, serverName, sessionId),
      logoutOAuth: (projectId, serverName) => engine.logoutProjectMcpOAuth(projectId, serverName),
    }),
    route("GET", "/projects/:projectId/board", async ({ res, params }) => {
      sendJson(res, 200, await engine.getBoard(params.projectId));
    }),
    route("GET", "/projects/:projectId/board/stream", async ({ req, res, params }) => {
      await streams.handleBoardStream(req, res, params.projectId);
    }),
  ];

  const conversationRoutes: readonly Route[] = [
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
        await streams.handleConversationStream(req, res, params.projectId, params.ref, window);
      },
    ),
  ];

  const questionRoutes: readonly Route[] = [
    route(
      "POST",
      "/projects/:projectId/questions/:questionId/answer",
      async ({ req, res, params }) => {
        const input = await readBody(req, AnswerQuestionRequestSchema, "AnswerQuestionRequest");
        const result = await engine.answerQuestion(params.projectId, params.questionId, input);
        sendJson(res, 200, result);
      },
    ),
  ];

  const workerRoutes: readonly Route[] = [
    route("GET", "/projects/:projectId/workers/:workerId/tasks", async ({ res, url, params }) => {
      const query = parseListWorkerTasksQuery(url);
      const { projectId, workerId } = params;
      sendJson(res, 200, await engine.listWorkerTasks(projectId, workerId, query));
    }),
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
      "GET",
      "/projects/:projectId/workers/:workerId/tasks/:taskId/stream",
      async ({ req, res, url, params }) => {
        const query = parseStreamWorkerTaskQuery(url);
        const { projectId, workerId, taskId } = params;
        await streams.handleTaskStream(req, res, projectId, workerId, taskId, query);
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

  return [
    ...systemRoutes,
    ...providerRoutes,
    ...modelRoutes,
    ...skillsRoutes,
    ...mcpRoutes,
    ...settingsRoutes,
    ...projectRoutes,
    ...conversationRoutes,
    ...questionRoutes,
    ...workerRoutes,
  ];
}
