import type { IncomingMessage, ServerResponse } from "node:http";
import type { Schema, Static } from "@earendil-works/pi-schema";
import {
  AnswerQuestionRequestSchema,
  BuiltinModelMatchRequestSchema,
  ConfigBundleSchema,
  CreateProjectRequestSchema,
  EngineSettingsSchema,
  ImportProviderModelsRequestSchema,
  LoginInputRequestSchema,
  McpOAuthInputRequestSchema,
  type McpStateResponse,
  ModelProfilesDocumentSchema,
  PickDirectoryRequestSchema,
  ProbeProviderRequestSchema,
  type ProjectMcpStateResponse,
  PutGlobalMcpConfigRequestSchema,
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
  UpsertGlobalMcpServerRequestSchema,
  UpsertMcpServerRequestSchema,
  UpsertProviderModelRequestSchema,
  UpsertProviderRequestSchema,
} from "@eevee/protocol";
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "./constants.ts";
import type { DirectoryPicker } from "./directory-picker.ts";
import type { Engine, ScopedMcpHandle } from "./engine.ts";
import {
  MAX_MESSAGE_BODY_BYTES,
  type PathParamsFor,
  parseEntriesQuery,
  parseListWorkerTasksQuery,
  parseModelsQuery,
  parseProjectFilesQuery,
  parseReadWorkerTaskQuery,
  parseStreamWorkerTaskQuery,
  parseWindowParams,
  prefixedRoute,
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

type ScopedMcpPrefix = "/mcp" | "/projects/:projectId/mcp";

function createScopedMcpRoutes<
  TState extends McpStateResponse | ProjectMcpStateResponse,
  TPutInput extends Static<typeof PutMcpConfigRequestSchema>,
  TUpsertInput extends Static<typeof UpsertMcpServerRequestSchema>,
>(
  prefix: ScopedMcpPrefix,
  schemas: {
    readonly putConfig: Schema<TPutInput>;
    readonly putConfigLabel: string;
    readonly upsertServer: Schema<TUpsertInput>;
    readonly upsertServerLabel: string;
  },
  getHandle: (projectId?: string) => ScopedMcpHandle<TState, TPutInput, TUpsertInput>,
  streams: SseStreamHandlers,
): readonly Route[] {
  const mcpRoute = <Suffix extends string>(
    method: string,
    suffix: Suffix,
    handle: (ctx: {
      readonly req: IncomingMessage;
      readonly res: ServerResponse;
      readonly params: PathParamsFor<`${ScopedMcpPrefix}${Suffix}`>;
    }) => Promise<void> | void,
  ): Route => prefixedRoute<ScopedMcpPrefix, Suffix>(method, prefix, suffix, handle);

  return [
    mcpRoute("GET", "", ({ res, params }) => {
      sendJson(res, 200, getHandle(params.projectId).getState());
    }),
    mcpRoute("PUT", "", async ({ req, res, params }) => {
      const input = await readBody(req, schemas.putConfig, schemas.putConfigLabel);
      sendJson(res, 200, await getHandle(params.projectId).putConfig(input));
    }),
    mcpRoute("POST", "/reconnect", async ({ req, res, params }) => {
      const input = await readOptionalBody(req, ReconnectMcpRequestSchema, "ReconnectMcpRequest");
      sendJson(res, 200, await getHandle(params.projectId).reconnect(input));
    }),
    mcpRoute("PUT", "/servers/:serverName", async ({ req, res, params }) => {
      const input = await readBody(req, schemas.upsertServer, schemas.upsertServerLabel);
      sendJson(res, 200, await getHandle(params.projectId).upsertServer(params.serverName, input));
    }),
    mcpRoute("DELETE", "/servers/:serverName", async ({ res, params }) => {
      sendJson(res, 200, await getHandle(params.projectId).deleteServer(params.serverName));
    }),
    mcpRoute("GET", "/servers/:serverName/logs", ({ res, params }) => {
      sendJson(res, 200, getHandle(params.projectId).getLogs(params.serverName));
    }),
    mcpRoute("POST", "/servers/:serverName/oauth/login", async ({ req, res, params }) => {
      await readOptionalJsonBody(req);
      sendJson(res, 201, await getHandle(params.projectId).startOAuth(params.serverName));
    }),
    mcpRoute(
      "GET",
      "/servers/:serverName/oauth/login/:sessionId/stream",
      ({ req, res, params }) => {
        streams.handleMcpOAuthStream(
          req,
          res,
          params.serverName,
          params.sessionId,
          params.projectId,
        );
      },
    ),
    mcpRoute(
      "POST",
      "/servers/:serverName/oauth/login/:sessionId/input",
      async ({ req, res, params }) => {
        const input = await readBody(req, McpOAuthInputRequestSchema, "McpOAuthInputRequest");
        sendJson(
          res,
          200,
          getHandle(params.projectId).submitOAuthInput(params.serverName, params.sessionId, input),
        );
      },
    ),
    mcpRoute(
      "POST",
      "/servers/:serverName/oauth/login/:sessionId/cancel",
      async ({ req, res, params }) => {
        await readOptionalJsonBody(req);
        sendJson(
          res,
          200,
          getHandle(params.projectId).cancelOAuth(params.serverName, params.sessionId),
        );
      },
    ),
    mcpRoute("DELETE", "/servers/:serverName/oauth", async ({ res, params }) => {
      sendJson(res, 200, await getHandle(params.projectId).logoutOAuth(params.serverName));
    }),
  ];
}

export type EngineRoutesOptions = {
  readonly onShutdown?: () => void;
  readonly streams: SseStreamHandlers;
  readonly webAuth: WebAuthManager;
  readonly directoryPicker: DirectoryPicker;
};

export function createEngineRoutes(engine: Engine, options: EngineRoutesOptions): readonly Route[] {
  const { streams } = options;
  const { providers, settings, skills, projects } = engine;

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
    route("POST", "/fs/pick-directory", async ({ req, res }) => {
      await withDisconnectSignal(req, async (signal) => {
        const input = await readOptionalBody(
          req,
          PickDirectoryRequestSchema,
          "PickDirectoryRequest",
        );
        sendJson(res, 200, await options.directoryPicker.pick(input, signal));
      });
    }),
  ];

  const providerRoutes: readonly Route[] = [
    route("GET", "/providers", async ({ res }) => {
      sendJson(res, 200, await providers.list());
    }),
    route("GET", "/providers/catalog", async ({ res }) => {
      sendJson(res, 200, await providers.catalog());
    }),
    route("POST", "/providers/probe", async ({ req, res }) => {
      await withDisconnectSignal(req, async (signal) => {
        const input = await readBody(req, ProbeProviderRequestSchema, "ProbeProviderRequest");
        sendJson(res, 200, await providers.probeDraft(input, signal));
      });
    }),
    route("POST", "/providers", async ({ req, res }) => {
      const input = await readBody(req, UpsertProviderRequestSchema, "UpsertProviderRequest");
      sendJson(res, 201, await providers.create(input));
    }),
    route("GET", "/providers/:providerId", async ({ res, params }) => {
      sendJson(res, 200, await providers.detail(params.providerId));
    }),
    route("PATCH", "/providers/:providerId", async ({ req, res, params }) => {
      const input = await readBody(req, UpsertProviderRequestSchema, "UpsertProviderRequest");
      sendJson(res, 200, await providers.update(params.providerId, input));
    }),
    route("DELETE", "/providers/:providerId", async ({ res, params }) => {
      sendJson(res, 200, await providers.delete(params.providerId));
    }),
    route("POST", "/providers/:providerId/models", async ({ req, res, params }) => {
      const input = await readBody(
        req,
        UpsertProviderModelRequestSchema,
        "UpsertProviderModelRequest",
      );
      sendJson(res, 201, await providers.createModel(params.providerId, input));
    }),
    route("POST", "/providers/:providerId/models/import", async ({ req, res, params }) => {
      const input = await readBody(
        req,
        ImportProviderModelsRequestSchema,
        "ImportProviderModelsRequest",
      );
      sendJson(res, 200, await providers.importModels(params.providerId, input));
    }),
    route("PATCH", "/providers/:providerId/models/:modelId", async ({ req, res, params }) => {
      const input = await readBody(
        req,
        UpsertProviderModelRequestSchema,
        "UpsertProviderModelRequest",
      );
      sendJson(res, 200, await providers.updateModel(params.providerId, params.modelId, input));
    }),
    route("DELETE", "/providers/:providerId/models/:modelId", async ({ res, params }) => {
      sendJson(res, 200, await providers.deleteModel(params.providerId, params.modelId));
    }),
    route("POST", "/providers/:providerId/probe", async ({ req, res, params }) => {
      await withDisconnectSignal(req, async (signal) => {
        const input = await readOptionalBody(
          req,
          ProbeProviderRequestSchema,
          "ProbeProviderRequest",
        );
        sendJson(res, 200, await providers.probe(params.providerId, input, signal));
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
          await providers.matchBuiltinModel(params.providerId, params.modelId, input),
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
          await providers.testModel(params.providerId, params.modelId, input, signal),
        );
      });
    }),
    route("PUT", "/providers/:providerId/auth/api-key", async ({ req, res, params }) => {
      const input = await readBody(req, SetApiKeyRequestSchema, "SetApiKeyRequest");
      sendJson(res, 200, await providers.setApiKey(params.providerId, input));
    }),
    route("DELETE", "/providers/:providerId/auth", async ({ res, params }) => {
      sendJson(res, 200, await providers.logout(params.providerId));
    }),
    route("POST", "/providers/:providerId/auth/login", async ({ req, res, params }) => {
      const input = await readBody(req, StartLoginRequestSchema, "StartLoginRequest");
      sendJson(res, 201, await providers.startLogin(params.providerId, input));
    }),
    route("GET", "/providers/:providerId/auth/login/:sessionId/stream", ({ req, res, params }) => {
      streams.handleLoginStream(req, res, params.providerId, params.sessionId);
    }),
    route(
      "POST",
      "/providers/:providerId/auth/login/:sessionId/input",
      async ({ req, res, params }) => {
        const input = await readBody(req, LoginInputRequestSchema, "LoginInputRequest");
        sendJson(res, 200, providers.submitLoginInput(params.providerId, params.sessionId, input));
      },
    ),
    route(
      "POST",
      "/providers/:providerId/auth/login/:sessionId/cancel",
      async ({ req, res, params }) => {
        await readOptionalJsonBody(req);
        sendJson(res, 200, providers.cancelLogin(params.providerId, params.sessionId));
      },
    ),
  ];

  const modelRoutes: readonly Route[] = [
    route("GET", "/models", async ({ res, url }) => {
      sendJson(res, 200, await providers.listModels(parseModelsQuery(url)));
    }),
    route("POST", "/models/refresh", async ({ req, res }) => {
      const input = await readOptionalBody(req, RefreshModelsRequestSchema, "RefreshModelsRequest");
      sendJson(res, 200, await providers.refreshModels(input));
    }),
    route("POST", "/models/reload", async ({ req, res }) => {
      await readOptionalJsonBody(req);
      sendJson(res, 200, await providers.reloadModels());
    }),
    route("GET", "/models/profiles", ({ res }) => {
      sendJson(res, 200, providers.getModelProfiles());
    }),
    route("PUT", "/models/profiles", async ({ req, res }) => {
      const input = await readBody(req, ModelProfilesDocumentSchema, "ModelProfilesDocument");
      sendJson(res, 200, providers.putModelProfiles(input));
    }),
  ];

  const skillsRoutes: readonly Route[] = [
    route("GET", "/skills", async ({ res }) => {
      sendJson(res, 200, await skills.list());
    }),
    route("PUT", "/skills/policy", async ({ req, res }) => {
      const input = await readBody(req, PutSkillsPolicyRequestSchema, "PutSkillsPolicyRequest");
      sendJson(res, 200, await skills.putPolicy(input));
    }),
  ];

  const mcpRoutes = createScopedMcpRoutes(
    "/mcp",
    {
      putConfig: PutGlobalMcpConfigRequestSchema,
      putConfigLabel: "PutGlobalMcpConfigRequest",
      upsertServer: UpsertGlobalMcpServerRequestSchema,
      upsertServerLabel: "UpsertGlobalMcpServerRequest",
    },
    () => engine.mcp(),
    streams,
  );

  const settingsRoutes: readonly Route[] = [
    route("GET", "/settings", ({ res }) => {
      sendJson(res, 200, settings.get());
    }),
    route("PATCH", "/settings", async ({ req, res }) => {
      const input = await readBody(req, EngineSettingsSchema, "EngineSettings");
      sendJson(res, 200, await settings.patch(input));
    }),
    route("PUT", "/settings", async ({ req, res }) => {
      const input = await readBody(req, EngineSettingsSchema, "EngineSettings");
      sendJson(res, 200, await settings.put(input));
    }),
    route("GET", "/config/export", async ({ res }) => {
      sendJson(res, 200, await settings.exportConfig());
    }),
    route("POST", "/config/import", async ({ req, res }) => {
      const input = await readBody(req, ConfigBundleSchema, "ConfigBundle");
      sendJson(res, 200, await settings.importConfig(input));
    }),
  ];

  const projectRoutes: readonly Route[] = [
    route("GET", "/boards/stream", async ({ req, res }) => {
      await streams.handleAllBoardsStream(req, res);
    }),
    route("GET", "/projects", ({ res }) => {
      sendJson(res, 200, { projects: projects.list() });
    }),
    route("POST", "/projects", async ({ req, res }) => {
      const input = await readBody(req, CreateProjectRequestSchema, "CreateProjectRequest");
      sendJson(res, 201, { project: projects.create(input) });
    }),
    route("GET", "/projects/:projectId", ({ res, params }) => {
      sendJson(res, 200, { project: projects.get(params.projectId) });
    }),
    route("PATCH", "/projects/:projectId", async ({ req, res, params }) => {
      const input = await readBody(req, UpdateProjectRequestSchema, "UpdateProjectRequest");
      sendJson(res, 200, await projects.update(params.projectId, input));
    }),
    route("DELETE", "/projects/:projectId", async ({ res, params }) => {
      sendJson(res, 200, await projects.delete(params.projectId));
    }),
    route("GET", "/projects/:projectId/memory", ({ res, params }) => {
      sendJson(res, 200, projects.getMemory(params.projectId));
    }),
    route("PUT", "/projects/:projectId/memory", async ({ req, res, params }) => {
      const input = await readBody(req, PutProjectMemoryRequestSchema, "PutProjectMemoryRequest");
      sendJson(res, 200, projects.putMemory(params.projectId, input));
    }),
    route("GET", "/projects/:projectId/usage", async ({ res, params }) => {
      sendJson(res, 200, await projects.getUsage(params.projectId));
    }),
    route("GET", "/projects/:projectId/files", async ({ res, url, params }) => {
      const query = parseProjectFilesQuery(url);
      sendJson(res, 200, await projects.listFiles(params.projectId, query));
    }),
    route("GET", "/projects/:projectId/tasks", async ({ res, url, params }) => {
      const query = parseListWorkerTasksQuery(url);
      sendJson(res, 200, await projects.listProjectTasks(params.projectId, query));
    }),
    route("GET", "/projects/:projectId/skills", async ({ res, params }) => {
      sendJson(res, 200, await skills.list(params.projectId));
    }),
    route("PUT", "/projects/:projectId/skills/policy", async ({ req, res, params }) => {
      const input = await readBody(req, PutSkillsPolicyRequestSchema, "PutSkillsPolicyRequest");
      sendJson(res, 200, await skills.putPolicy(input, params.projectId));
    }),
    ...createScopedMcpRoutes(
      "/projects/:projectId/mcp",
      {
        putConfig: PutMcpConfigRequestSchema,
        putConfigLabel: "PutMcpConfigRequest",
        upsertServer: UpsertMcpServerRequestSchema,
        upsertServerLabel: "UpsertMcpServerRequest",
      },
      (projectId) => engine.mcp(projectId ?? ""),
      streams,
    ),
    route("GET", "/projects/:projectId/board", async ({ res, params }) => {
      sendJson(res, 200, await projects.getBoard(params.projectId));
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
        const input = await readBody(
          req,
          SendMessageRequestSchema,
          "SendMessageRequest",
          MAX_MESSAGE_BODY_BYTES,
        );
        sendJson(res, 202, await projects.sendMessage(params.projectId, params.ref, input));
      },
    ),
    route(
      "GET",
      "/projects/:projectId/conversations/:ref/entries",
      async ({ res, url, params }) => {
        const query = parseEntriesQuery(url);
        sendJson(res, 200, await projects.listEntries(params.projectId, params.ref, query));
      },
    ),
    route("POST", "/projects/:projectId/conversations/:ref/interrupt", async ({ res, params }) => {
      sendJson(res, 200, await projects.interrupt(params.projectId, params.ref));
    }),
    route("POST", "/projects/:projectId/conversations/:ref/retry", async ({ res, params }) => {
      sendJson(res, 202, await projects.retry(params.projectId, params.ref));
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
        const result = await projects.answerQuestion(params.projectId, params.questionId, input);
        sendJson(res, 200, result);
      },
    ),
  ];

  const workerRoutes: readonly Route[] = [
    route("GET", "/projects/:projectId/workers/:workerId/tasks", async ({ res, url, params }) => {
      const query = parseListWorkerTasksQuery(url);
      const { projectId, workerId } = params;
      sendJson(res, 200, await projects.listWorkerTasks(projectId, workerId, query));
    }),
    route(
      "GET",
      "/projects/:projectId/workers/:workerId/tasks/:taskId",
      async ({ res, url, params }) => {
        const query = parseReadWorkerTaskQuery(url);
        const { projectId, workerId, taskId } = params;
        sendJson(res, 200, await projects.readWorkerTask(projectId, workerId, taskId, query));
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
        sendJson(res, 200, await projects.killWorkerTask(projectId, workerId, taskId));
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
