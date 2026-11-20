import { type ModelChoice, ProblemError } from "../domain/index.ts";
import type { Engine } from "../engine/engine.ts";
import { memoryFile } from "../engine/project/memory.ts";
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
  const project = (id: string) => engine.projects.require(id);
  const text = (value: string, field: string) => {
    if (value.trim() === "") throw new ProblemError({ code: "required", field });
    return value;
  };
  const optionalText = (value: string | undefined) => value?.trim() || undefined;
  const model = (choice: ModelChoice): ModelChoice => ({
    ...choice,
    provider: text(choice.provider, "provider"),
    modelId: text(choice.modelId, "modelId"),
  });

  return {
    "GET /api/health": { handle: async () => ({ version, bootId: engine.bootId }) },
    "GET /api/engine": {
      handle: async () => ({ bootId: engine.bootId, version, port: port(), pid: process.pid }),
    },
    "POST /api/engine/shutdown": {
      handle: async () => {
        setImmediate(shutdown);
      },
    },
    "POST /api/session": {
      handle: async ({ body }) => {
        const token = auth.exchange(text(body.code, "code"));
        if (token === undefined) throw new ProblemError({ code: "bad_code" });
        return { token };
      },
    },
    "POST /api/session/codes": { handle: async () => ({ code: auth.issueCode() }) },
    "GET /api/models": { handle: async () => engine.models.catalog() },
    "PUT /api/models/defaults/:role": {
      handle: async ({ params, body }) => {
        await engine.models.setDefault(params.role, model(body));
        return engine.models.catalog();
      },
    },
    "GET /api/models/config": {
      handle: async () => ({ providers: await engine.models.providers() }),
    },
    "PUT /api/models/providers/:provider": {
      handle: async ({ params, body }) => engine.models.saveProvider(params.provider, body.config),
    },
    "DELETE /api/models/providers/:provider": {
      handle: async ({ params }) => engine.models.saveProvider(params.provider, undefined),
    },
    "PUT /api/models/providers/:provider/credentials": {
      handle: async ({ params, body }) =>
        engine.models.login(params.provider, text(body.key, "key")),
    },
    "DELETE /api/models/providers/:provider/credentials": {
      handle: async ({ params }) => engine.models.logout(params.provider),
    },
    "POST /api/models/builtin/search": {
      handle: async ({ body }) => ({
        models: engine.models.builtin(text(body.query, "query"), optionalText(body.api)),
      }),
    },
    "POST /api/models/probe": {
      handle: async ({ body }) =>
        engine.models.probe({
          ...body,
          baseUrl: text(body.baseUrl, "baseUrl"),
          provider: optionalText(body.provider),
          api: optionalText(body.api),
          key: optionalText(body.key),
        }),
    },
    "GET /api/capabilities": { handle: async () => engine.capabilities.view() },
    "PATCH /api/capabilities/roles/:role": {
      handle: async ({ params, body }) => engine.capabilities.setRole(params.role, body),
    },
    "GET /api/mcp/config": {
      handle: async () => ({
        servers: (await engine.capabilities.mcpConfig()) as Record<string, Record<string, unknown>>,
      }),
    },
    "PUT /api/mcp/servers/:server": {
      handle: async ({ params, body }) =>
        engine.capabilities.saveMcpServer(params.server, body.config),
    },
    "DELETE /api/mcp/servers/:server": {
      handle: async ({ params }) => engine.capabilities.saveMcpServer(params.server, undefined),
    },
    "POST /api/mcp/reload": { handle: async () => engine.capabilities.reloadMcp() },
    "GET /api/projects": { handle: async () => ({ projects: engine.projects.list() }) },
    "POST /api/projects": {
      handle: async ({ body }) =>
        engine.projects.create({
          title: text(body.title, "title"),
          workspace: text(body.workspace, "workspace"),
        }),
    },
    "GET /api/projects/:project": {
      handle: async ({ params }) => project(params.project).summary(),
    },
    "PUT /api/projects/:project/models/:role": {
      handle: async ({ params, body }) =>
        engine.models.setProjectModel(project(params.project), params.role, model(body)),
    },
    "DELETE /api/projects/:project/models/:role": {
      handle: async ({ params }) =>
        engine.models.setProjectModel(project(params.project), params.role, null),
    },
    "GET /api/projects/:project/usage": {
      handle: async ({ params }) => project(params.project).usage(),
    },
    "GET /api/projects/:project/board": {
      handle: async ({ params }) => project(params.project).board(),
    },
    "GET /api/projects/:project/conversations/:conversation": {
      handle: async ({ params }) => project(params.project).conversations.view(params.conversation),
    },
    "POST /api/projects/:project/conversations/:conversation/messages": {
      handle: async ({ params, body }) => {
        await project(params.project).conversations.send(
          params.conversation,
          text(body.text, "text"),
          body.mode,
        );
      },
    },
    "POST /api/projects/:project/conversations/:conversation/interrupt": {
      handle: async ({ params }) =>
        project(params.project).conversations.interrupt(params.conversation),
    },
    "POST /api/projects/:project/conversations/:conversation/retry": {
      handle: async ({ params }) =>
        project(params.project).conversations.retry(params.conversation),
    },
    "DELETE /api/projects/:project/conversations/:conversation/queue/:submission": {
      handle: async ({ params }) =>
        project(params.project).conversations.withdrawQueued(
          params.conversation,
          params.submission,
        ),
    },
    "POST /api/projects/:project/conversations/:conversation/queue/:submission/steer": {
      handle: async ({ params }) => {
        await project(params.project).conversations.steerQueued(
          params.conversation,
          params.submission,
        );
      },
    },
    "GET /api/projects/:project/questions/:question": {
      handle: async ({ params }) => project(params.project).questions.get(params.question),
    },
    "POST /api/projects/:project/questions/:question/answer": {
      handle: async ({ params, body }) =>
        project(params.project).questions.answer(
          params.question,
          text(body.answer, "answer"),
          body.answers,
        ),
    },
    "GET /api/projects/:project/jobs/:job/log": {
      handle: async ({ params }) => project(params.project).jobs.log(params.job),
    },
    "POST /api/projects/:project/jobs/:job/kill": {
      handle: async ({ params }) => project(params.project).jobs.kill(params.job),
    },
    "GET /api/projects/:project/memory/files": {
      handle: async ({ params }) => ({
        files: await project(params.project).memory.files("project"),
      }),
    },
    "GET /api/projects/:project/memory/files/:file": {
      handle: async ({ params }) => project(params.project).memory.file("project", params.file),
    },
    "GET /api/projects/:project/memory/changes": {
      handle: async ({ params }) => ({
        changes: await project(params.project).memory.history("project"),
      }),
    },
    "GET /api/projects/:project/memory/changes/:change": {
      handle: async ({ params }) => project(params.project).memory.show("project", params.change),
    },
    "POST /api/projects/:project/memory/changes/:change/undo": {
      handle: async ({ params }) => project(params.project).memory.undo("project", params.change),
    },
    "GET /api/memory/files": { handle: async () => ({ files: await engine.memory.listFiles() }) },
    "GET /api/memory/files/:file": {
      handle: async ({ params }) => memoryFile(engine.memory, params.file),
    },
    "GET /api/memory/changes": { handle: async () => ({ changes: await engine.memory.history() }) },
    "GET /api/memory/changes/:change": {
      handle: async ({ params }) => engine.memory.show(params.change),
    },
    "POST /api/memory/changes/:change/undo": {
      handle: async ({ params }) => engine.memory.undo(params.change, { kind: "user" }),
    },
  };
}
