import type { QuestionId, TicketId } from "../contracts/index.ts";
import type { Engine } from "../engine/engine.ts";
import type { Auth } from "./auth.ts";
import { HttpError, type RouteTable } from "./http.ts";

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
    if (host === undefined) throw new HttpError(404, "no_project", `没有项目 ${id}`);
    return host;
  };
  const text = (value: unknown, field: string) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new HttpError(400, "bad_request", `${field} 不能为空`);
    }
    return value;
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
      cliOnly: true,
      handle: async () => {
        setImmediate(shutdown);
        return { ok: true };
      },
    },
    "POST /api/session": {
      public: true,
      handle: async ({ body }) => {
        const token = await auth.exchange(text(body?.code, "code"));
        if (token === undefined)
          throw new HttpError(401, "bad_code", "授权码无效或已过期，请重新运行 eevee web");
        return { token };
      },
    },
    "POST /api/session/code": { cliOnly: true, handle: async () => ({ code: auth.issueCode() }) },
    "GET /api/models": { handle: async () => ({ catalog: await engine.catalog() }) },
    "POST /api/settings/models": {
      handle: async ({ body }) => {
        const role = body?.role ?? "default";
        if (!["default", "router", "worker", "dreamer"].includes(role)) {
          throw new HttpError(400, "bad_request", `未知角色 ${role}`);
        }
        await engine.setDefaultModel(role, {
          provider: text(body?.provider, "provider"),
          modelId: text(body?.modelId, "modelId"),
        });
        return { ok: true };
      },
    },
    "POST /api/auth/:provider": {
      cliOnly: true,
      handle: async ({ params, body }) => {
        await engine.login(params.provider, text(body?.key, "key"));
        return { ok: true };
      },
    },
    "POST /api/projects": {
      handle: async ({ body }) =>
        engine.createProject({
          title: text(body?.title, "title"),
          workspace: text(body?.workspace, "workspace"),
        }),
    },
    "GET /api/projects/:project/board": {
      handle: async ({ params }) => project(params.project).board(),
    },
    "GET /api/projects/:project/conversation": {
      handle: async ({ params }) => project(params.project).conversation(),
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
          throw new HttpError(400, "bad_request", "mode 只能是 steer 或 followUp");
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
