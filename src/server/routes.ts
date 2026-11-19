import { MEMORY_SCOPES } from "../api/contract.ts";
import {
  type JobId,
  type MemoryScope,
  type ModelChoice,
  ProblemError,
  type QuestionId,
  ROLE_NAMES,
  type RoleName,
  type TicketId,
} from "../contracts/index.ts";
import type { Engine } from "../engine/engine.ts";
import type { Auth } from "./auth.ts";
import type { RouteTable } from "./http.ts";

export type RouteDeps = {
  engine: Engine;
  auth: Auth;
  port: () => number;
  version: string;
  shutdown: () => void;
};

export function createRoutes({ engine, auth, port, version, shutdown }: RouteDeps): RouteTable {
  const project = (id: string) => {
    const host = engine.project(id);
    if (host === undefined) throw new ProblemError({ code: "no_project", projectId: id });
    return host;
  };
  const text = (value: string, field: string) => {
    if (value.trim() === "") {
      throw new ProblemError({ code: "required", field });
    }
    return value;
  };

  const optionalText = (value: string | undefined): string | undefined => {
    if (value === undefined || value.trim() === "") return undefined;
    return value.trim();
  };
  const role = (value: string): RoleName => {
    if (!(ROLE_NAMES as readonly string[]).includes(value)) {
      throw new ProblemError({ code: "invalid", field: "role", allowed: ROLE_NAMES });
    }
    return value as RoleName;
  };
  const modelRole = (value: string | undefined): RoleName | "default" =>
    value === undefined || value === "default" ? "default" : role(value);
  /** The model a body names, blank fields counting as missing. */
  const model = (body: ModelChoice): ModelChoice => ({
    provider: text(body.provider, "provider"),
    modelId: text(body.modelId, "modelId"),
    ...(body.thinkingLevel === undefined ? {} : { thinkingLevel: body.thinkingLevel }),
  });
  const scope = (value: string): MemoryScope => {
    if (!(MEMORY_SCOPES as readonly string[]).includes(value)) {
      throw new ProblemError({ code: "invalid", field: "scope", allowed: MEMORY_SCOPES });
    }
    return value as MemoryScope;
  };

  const changeId = (value: string): number => {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1) {
      throw new ProblemError({ code: "invalid", field: "change", allowed: ["a change number"] });
    }
    return id;
  };

  return {
    "GET /api/health": { public: true, handle: async () => ({ ok: true }) },
    "GET /api/status": {
      handle: async () => ({
        bootId: engine.bootId,
        version,
        port: port(),
        projects: engine.projects(),
      }),
    },
    "POST /api/shutdown": {
      handle: async () => {
        setImmediate(shutdown);
        return { ok: true };
      },
    },
    "POST /api/session": {
      public: true,
      handle: async ({ body }) => {
        const token = auth.exchange(text(body.code, "code"));
        if (token === undefined) throw new ProblemError({ code: "bad_code" });
        return { token };
      },
    },
    "POST /api/session/code": { handle: async () => ({ code: auth.issueCode() }) },
    "GET /api/models": { handle: async () => engine.catalog() },
    "POST /api/settings/models": {
      handle: async ({ body }) => {
        await engine.setDefaultModel(modelRole(body.role), model(body));
        return { ok: true };
      },
    },
    "POST /api/auth/:provider": {
      handle: async ({ params, body }) => {
        await engine.login(params.provider, text(body.key, "key"));
        return { ok: true };
      },
    },
    "DELETE /api/auth/:provider": {
      handle: async ({ params }) => {
        await engine.logout(params.provider);
        return { ok: true };
      },
    },
    "GET /api/models/config": {
      handle: async () => ({ providers: await engine.modelsConfig() }),
    },
    "PUT /api/models/providers/:provider": {
      // The Engine checks the entry against the models.json schema before writing it.
      handle: async ({ params, body }) => engine.saveProvider(params.provider, body.config),
    },
    "DELETE /api/models/providers/:provider": {
      handle: async ({ params }) => engine.saveProvider(params.provider, undefined),
    },
    "POST /api/models/builtin": {
      handle: async ({ body }) => ({
        models: engine.builtinModels(text(body.query, "query"), optionalText(body.api)),
      }),
    },
    "POST /api/models/probe": {
      handle: async ({ body }) =>
        engine.probeModels({
          ...(body.provider === undefined ? {} : { provider: optionalText(body.provider) }),
          baseUrl: text(body.baseUrl, "baseUrl"),
          ...(body.api === undefined ? {} : { api: optionalText(body.api) }),
          ...(body.key === undefined ? {} : { key: optionalText(body.key) }),
          ...(body.headers === undefined ? {} : { headers: body.headers }),
        }),
    },
    "GET /api/capabilities": { handle: async () => engine.capabilities() },
    "POST /api/capabilities/roles/:role": {
      handle: async ({ params, body }) =>
        engine.setRoleCapability(role(params.role), {
          ...(body.extensions === undefined ? {} : { extensions: body.extensions }),
          ...(body.maxTurns === undefined ? {} : { maxTurns: body.maxTurns }),
        }),
    },
    "POST /api/mcp/reload": { handle: async () => engine.reloadMcp() },
    "GET /api/mcp/config": {
      handle: async () => ({
        servers: (await engine.mcpConfig()) as Record<string, Record<string, unknown>>,
      }),
    },
    "PUT /api/mcp/servers/:server": {
      handle: async ({ params, body }) => engine.saveMcpServer(params.server, body.config),
    },
    "DELETE /api/mcp/servers/:server": {
      handle: async ({ params }) => engine.saveMcpServer(params.server, undefined),
    },
    "POST /api/projects": {
      handle: async ({ body }) =>
        engine.createProject({
          title: text(body.title, "title"),
          workspace: text(body.workspace, "workspace"),
        }),
    },
    "POST /api/projects/:project/models": {
      handle: async ({ params, body }) =>
        engine.setProjectModel(
          project(params.project),
          modelRole(body.role),
          body.model === null ? null : model(body.model),
        ),
    },
    "GET /api/projects/:project/usage": {
      handle: async ({ params }) => project(params.project).usage(),
    },
    "GET /api/projects/:project/memory/:scope/changes": {
      handle: async ({ params }) => ({
        changes: await project(params.project).memory(scope(params.scope)).history(),
      }),
    },
    "GET /api/projects/:project/memory/:scope/changes/:change": {
      handle: async ({ params }) =>
        project(params.project).memory(scope(params.scope)).show(changeId(params.change)),
    },
    "POST /api/projects/:project/memory/:scope/changes/:change/undo": {
      handle: async ({ params }) =>
        project(params.project)
          .memory(scope(params.scope))
          .undo(changeId(params.change), { kind: "user" }),
    },
    "GET /api/projects/:project/memory/:scope/files": {
      handle: async ({ params }) => ({
        files: await project(params.project).memory(scope(params.scope)).listFiles(),
      }),
    },
    "GET /api/projects/:project/memory/:scope/files/:file": {
      handle: async ({ params }) =>
        project(params.project).memoryFile(scope(params.scope), params.file),
    },
    "GET /api/projects/:project/jobs/:job/log": {
      handle: async ({ params }) => project(params.project).jobLog(params.job as JobId),
    },
    "POST /api/projects/:project/jobs/:job/kill": {
      handle: async ({ params }) => {
        await project(params.project).killJob(params.job as JobId);
        return { ok: true };
      },
    },
    "POST /api/projects/:project/conversation/retry": {
      handle: async ({ params }) => {
        await project(params.project).retry();
        return { ok: true };
      },
    },
    "POST /api/projects/:project/messages": {
      handle: async ({ params, body }) => {
        await project(params.project).sendUserMessage(text(body.text, "text"));
        return { ok: true };
      },
    },
    "POST /api/projects/:project/tickets/:ticket/retry": {
      handle: async ({ params }) => {
        await project(params.project).retry(params.ticket as TicketId);
        return { ok: true };
      },
    },
    "POST /api/projects/:project/tickets/:ticket/messages": {
      handle: async ({ params, body }) => {
        await project(params.project).messageWorker(
          params.ticket as TicketId,
          text(body.text, "text"),
          body.mode ?? "steer",
        );
        return { ok: true };
      },
    },
    "POST /api/projects/:project/tickets/:ticket/interrupt": {
      handle: async ({ params }) => {
        await project(params.project).interruptWorker(params.ticket as TicketId);
        return { ok: true };
      },
    },
    "POST /api/projects/:project/questions/:question/answer": {
      handle: async ({ params, body }) => {
        await project(params.project).answerQuestion(
          params.question as QuestionId,
          text(body.answer, "answer"),
        );
        return { ok: true };
      },
    },
  };
}
