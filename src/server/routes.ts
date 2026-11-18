import { MEMORY_SCOPES } from "../api/contract.ts";
import {
  type JobId,
  type MemoryScope,
  type ModelChoice,
  ProblemError,
  type QuestionId,
  ROLE_NAMES,
  type RoleName,
  THINKING_LEVELS,
  type ThinkingLevel,
  type TicketId,
} from "../contracts/index.ts";
import type { Engine } from "../engine/engine.ts";
import type { ProviderConfig } from "../models/models-config.ts";
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
  const text = (value: unknown, field: string) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ProblemError({ code: "required", field });
    }
    return value;
  };

  const optionalText = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new ProblemError({ code: "invalid", field });
    return value.trim() === "" ? undefined : value.trim();
  };
  const record = (value: unknown, field: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ProblemError({ code: "invalid", field });
    }
    return value as Record<string, unknown>;
  };

  const role = (value: unknown): RoleName => {
    if (!ROLE_NAMES.includes(value as RoleName)) {
      throw new ProblemError({ code: "invalid", field: "role", allowed: ROLE_NAMES });
    }
    return value as RoleName;
  };
  const modelRole = (value: unknown): RoleName | "default" =>
    value === undefined || value === "default" ? "default" : role(value);
  const model = (value: unknown): ModelChoice => {
    const body = value as Record<string, unknown> | undefined;
    const thinkingLevel = body?.thinkingLevel;
    if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)) {
      throw new ProblemError({
        code: "invalid",
        field: "thinkingLevel",
        allowed: THINKING_LEVELS,
      });
    }
    return {
      provider: text(body?.provider, "provider"),
      modelId: text(body?.modelId, "modelId"),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as ThinkingLevel }),
    };
  };
  const scope = (value: string): MemoryScope => {
    if (!MEMORY_SCOPES.includes(value as MemoryScope)) {
      throw new ProblemError({ code: "invalid", field: "scope", allowed: MEMORY_SCOPES });
    }
    return value as MemoryScope;
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
        const token = auth.exchange(text(body?.code, "code"));
        if (token === undefined) throw new ProblemError({ code: "bad_code" });
        return { token };
      },
    },
    "POST /api/session/code": { handle: async () => ({ code: auth.issueCode() }) },
    "GET /api/models": { handle: async () => engine.catalog() },
    "POST /api/settings/models": {
      handle: async ({ body }) => {
        await engine.setDefaultModel(modelRole(body?.role), model(body));
        return { ok: true };
      },
    },
    "POST /api/auth/:provider": {
      handle: async ({ params, body }) => {
        await engine.login(params.provider, text(body?.key, "key"));
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
      handle: async ({ params, body }) =>
        engine.saveProvider(params.provider, record(body?.config, "config") as ProviderConfig),
    },
    "DELETE /api/models/providers/:provider": {
      handle: async ({ params }) => engine.saveProvider(params.provider, undefined),
    },
    "POST /api/models/builtin": {
      handle: async ({ body }) => {
        const api = optionalText(body?.api, "api");
        return { models: engine.builtinModels(text(body?.query, "query"), api) };
      },
    },
    "POST /api/models/probe": {
      handle: async ({ body }) => {
        const provider = optionalText(body?.provider, "provider");
        const key = optionalText(body?.key, "key");
        const api = optionalText(body?.api, "api");
        const headers = body?.headers === undefined ? undefined : record(body.headers, "headers");
        if (headers !== undefined && Object.values(headers).some((v) => typeof v !== "string")) {
          throw new ProblemError({ code: "invalid", field: "headers" });
        }
        return engine.probeModels({
          ...(provider === undefined ? {} : { provider }),
          baseUrl: text(body?.baseUrl, "baseUrl"),
          ...(api === undefined ? {} : { api }),
          ...(key === undefined ? {} : { key }),
          ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
        });
      },
    },
    "GET /api/capabilities": { handle: async () => engine.capabilities() },
    "POST /api/capabilities/roles/:role": {
      handle: async ({ params, body }) => {
        const extensions = body?.extensions;
        if (
          extensions !== undefined &&
          (!Array.isArray(extensions) || extensions.some((e) => typeof e !== "string"))
        ) {
          throw new ProblemError({ code: "invalid", field: "extensions" });
        }
        const maxTurns = body?.maxTurns;
        if (
          maxTurns !== undefined &&
          maxTurns !== null &&
          !(Number.isInteger(maxTurns) && maxTurns >= 1)
        ) {
          throw new ProblemError({ code: "invalid", field: "maxTurns" });
        }
        return engine.setRoleCapability(role(params.role), {
          ...(extensions === undefined ? {} : { extensions }),
          ...(maxTurns === undefined ? {} : { maxTurns }),
        });
      },
    },
    "POST /api/mcp/reload": { handle: async () => engine.reloadMcp() },
    "GET /api/mcp/config": {
      handle: async () => ({
        servers: (await engine.mcpConfig()) as Record<string, Record<string, unknown>>,
      }),
    },
    "PUT /api/mcp/servers/:server": {
      handle: async ({ params, body }) =>
        engine.saveMcpServer(params.server, record(body?.config, "config")),
    },
    "DELETE /api/mcp/servers/:server": {
      handle: async ({ params }) => engine.saveMcpServer(params.server, undefined),
    },
    "POST /api/projects": {
      handle: async ({ body }) =>
        engine.createProject({
          title: text(body?.title, "title"),
          workspace: text(body?.workspace, "workspace"),
        }),
    },
    "POST /api/projects/:project/models": {
      handle: async ({ params, body }) =>
        engine.setProjectModel(
          project(params.project),
          modelRole(body?.role),
          body?.model === null ? null : model(body?.model),
        ),
    },
    "GET /api/projects/:project/board": {
      handle: async ({ params }) => project(params.project).board(),
    },
    "GET /api/projects/:project/conversation": {
      handle: async ({ params }) => project(params.project).conversation(),
    },
    "GET /api/projects/:project/usage": {
      handle: async ({ params }) => project(params.project).usage(),
    },
    "GET /api/projects/:project/memory/:scope/log": {
      handle: async ({ params }) => ({
        commits: await project(params.project).memoryLog(scope(params.scope)),
      }),
    },
    "GET /api/projects/:project/memory/:scope/files": {
      handle: async ({ params }) => ({
        files: await project(params.project).memoryFiles(scope(params.scope)),
      }),
    },
    "GET /api/projects/:project/memory/:scope/files/:file": {
      handle: async ({ params }) =>
        project(params.project).memoryFile(scope(params.scope), params.file),
    },
    "GET /api/projects/:project/memory/:scope/commits/:commit": {
      handle: async ({ params }) => ({
        diff: await project(params.project).memoryDiff(scope(params.scope), params.commit),
      }),
    },
    "GET /api/projects/:project/memory/:scope/diff": {
      handle: async ({ params }) => ({
        diff: await project(params.project).memoryDiff(scope(params.scope)),
      }),
    },
    "POST /api/projects/:project/memory/:scope/revert": {
      handle: async ({ params, body }) => {
        await project(params.project).memoryRevert(
          scope(params.scope),
          text(body?.commit, "commit"),
        );
        return { ok: true };
      },
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
        await project(params.project).sendUserMessage(text(body?.text, "text"));
        return { ok: true };
      },
    },
    "GET /api/projects/:project/tickets/:ticket/conversation": {
      handle: async ({ params }) =>
        project(params.project).ticketConversation(params.ticket as TicketId),
    },
    "POST /api/projects/:project/tickets/:ticket/retry": {
      handle: async ({ params }) => {
        await project(params.project).retry(params.ticket as TicketId);
        return { ok: true };
      },
    },
    "POST /api/projects/:project/tickets/:ticket/messages": {
      handle: async ({ params, body }) => {
        const mode = body?.mode ?? "steer";
        if (mode !== "steer" && mode !== "followUp") {
          throw new ProblemError({
            code: "invalid",
            field: "mode",
            allowed: ["steer", "followUp"],
          });
        }
        await project(params.project).messageWorker(
          params.ticket as TicketId,
          text(body?.text, "text"),
          mode,
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
          text(body?.answer, "answer"),
        );
        return { ok: true };
      },
    },
  };
}
