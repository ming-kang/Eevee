import {
  arr,
  int,
  map,
  nullable,
  obj,
  oneOf,
  opt,
  type Schema,
  type Static,
  str,
  unsafe,
} from "@earendil-works/pi-schema";
import {
  type JobId,
  type MemoryChange,
  type MemoryChangeDetail,
  type MemoryScope,
  ProblemError,
  parseConversationRef,
  type Question,
  type QuestionId,
  ROLE_NAMES,
  THINKING_LEVELS,
  type TicketId,
} from "../domain/index.ts";
import type {
  BoardView,
  BuiltinModelView,
  CapabilitiesView,
  ConversationView,
  EngineInfo,
  JobLogView,
  MemoryFileEntry,
  MemoryFileView,
  ModelsView,
  ProbedModelView,
  ProjectSummary,
  ProviderConfigView,
  UsageView,
} from "./views.ts";

export type * from "./views.ts";
export const TOKEN_HEADER = "x-eevee-token";
export const MEMORY_SCOPES: readonly MemoryScope[] = ["project", "global"];

export type Param<T = unknown> = { schema: Schema<string>; parse(value: string): T };
const param = <T extends string>(schema: Schema<T>): Param<T> => ({
  schema,
  parse: (value) => value as T,
});
export const PARAMS = {
  project: param(str({ pattern: "^p[a-zA-Z0-9_-]+$" })),
  ticket: param(unsafe<TicketId>({ type: "string", pattern: "^t[1-9][0-9]*$" })),
  conversation: {
    schema: str({ pattern: "^(router|t[1-9][0-9]*)$" }),
    parse: parseConversationRef,
  },
  job: param(unsafe<JobId>({ type: "string", pattern: "^j[1-9][0-9]*$" })),
  question: param(unsafe<QuestionId>({ type: "string", pattern: "^q[1-9][0-9]*$" })),
  role: param(oneOf(ROLE_NAMES)),
  modelRole: param(oneOf([...ROLE_NAMES, "default"] as const)),
  scope: param(oneOf(["project", "global"] as const)),
  change: {
    schema: str({ pattern: "^[1-9][0-9]*$" }),
    parse(value: string): number {
      const id = Number(value);
      if (!Number.isSafeInteger(id)) throw new ProblemError({ code: "invalid", field: "change" });
      return id;
    },
  },
  submission: param(str({ pattern: "^[1-9][0-9]*$" })),
  name: param(str({ minLength: 1 })),
};

const body = <P extends Parameters<typeof obj>[0]>(properties: P) =>
  obj(properties, { open: true });
const model = body({ provider: str(), modelId: str(), thinkingLevel: opt(oneOf(THINKING_LEVELS)) });
const project = { project: PARAMS.project };
const conversation = { ...project, conversation: PARAMS.conversation };
const question = { ...project, question: PARAMS.question };
const job = { ...project, job: PARAMS.job };
const provider = { provider: PARAMS.name };
const server = { server: PARAMS.name };
const file = { file: PARAMS.name };
const change = { change: PARAMS.change };

function route<R>() {
  return <
    const K extends string,
    const P extends Record<string, Param>,
    B extends Schema | undefined,
  >(
    key: K,
    params: P,
    body: B,
    status = 200,
    isPublic = false,
  ) => {
    const [method, path] = key.split(" ") as [string, string];
    return { key, method, path, params, body, status, public: isPublic, response: undefined as R };
  };
}

export const ROUTES = [
  route<{ version: string; bootId: string }>()("GET /api/health", {}, undefined, 200, true),
  route<EngineInfo>()("GET /api/engine", {}, undefined),
  route<void>()("POST /api/engine/shutdown", {}, undefined, 204),
  route<{ token: string }>()("POST /api/session", {}, body({ code: str() }), 200, true),
  route<{ code: string }>()("POST /api/session/codes", {}, undefined),
  route<ModelsView>()("GET /api/models", {}, undefined),
  route<ModelsView>()("PUT /api/models/defaults/:role", { role: PARAMS.modelRole }, model),
  route<{ providers: Record<string, ProviderConfigView> }>()(
    "GET /api/models/config",
    {},
    undefined,
  ),
  route<ModelsView>()(
    "PUT /api/models/providers/:provider",
    provider,
    body({ config: unsafe<ProviderConfigView>({ type: "object" }) }),
  ),
  route<ModelsView>()("DELETE /api/models/providers/:provider", provider, undefined),
  route<void>()(
    "PUT /api/models/providers/:provider/credentials",
    provider,
    body({ key: str() }),
    204,
  ),
  route<void>()("DELETE /api/models/providers/:provider/credentials", provider, undefined, 204),
  route<{ models: BuiltinModelView[] }>()(
    "POST /api/models/builtin/search",
    {},
    body({ query: str(), api: opt(str()) }),
  ),
  route<{ models: ProbedModelView[]; truncated: boolean }>()(
    "POST /api/models/probe",
    {},
    body({
      provider: opt(str()),
      baseUrl: str(),
      api: opt(str()),
      key: opt(str()),
      headers: opt(map(str())),
    }),
  ),
  route<CapabilitiesView>()("GET /api/capabilities", {}, undefined),
  route<CapabilitiesView>()(
    "PATCH /api/capabilities/roles/:role",
    { role: PARAMS.role },
    body({ extensions: opt(arr(str())), maxTurns: opt(nullable(int({ minimum: 1 }))) }),
  ),
  route<{ servers: Record<string, Record<string, unknown>> }>()(
    "GET /api/mcp/config",
    {},
    undefined,
  ),
  route<CapabilitiesView>()(
    "PUT /api/mcp/servers/:server",
    server,
    body({ config: unsafe<Record<string, unknown>>({ type: "object" }) }),
  ),
  route<CapabilitiesView>()("DELETE /api/mcp/servers/:server", server, undefined),
  route<CapabilitiesView>()("POST /api/mcp/reload", {}, undefined),
  route<{ projects: ProjectSummary[] }>()("GET /api/projects", {}, undefined),
  route<ProjectSummary>()("POST /api/projects", {}, body({ title: str(), workspace: str() }), 201),
  route<ProjectSummary>()("GET /api/projects/:project", project, undefined),
  route<ProjectSummary>()(
    "PUT /api/projects/:project/models/:role",
    { ...project, role: PARAMS.modelRole },
    model,
  ),
  route<ProjectSummary>()(
    "DELETE /api/projects/:project/models/:role",
    { ...project, role: PARAMS.modelRole },
    undefined,
  ),
  route<UsageView>()("GET /api/projects/:project/usage", project, undefined),
  route<BoardView>()("GET /api/projects/:project/board", project, undefined),
  route<ConversationView>()(
    "GET /api/projects/:project/conversations/:conversation",
    conversation,
    undefined,
  ),
  route<void>()(
    "POST /api/projects/:project/conversations/:conversation/messages",
    conversation,
    body({ text: str(), mode: opt(oneOf(["steer", "followUp"] as const)) }),
    204,
  ),
  route<void>()(
    "POST /api/projects/:project/conversations/:conversation/interrupt",
    conversation,
    undefined,
    204,
  ),
  route<void>()(
    "POST /api/projects/:project/conversations/:conversation/retry",
    conversation,
    undefined,
    204,
  ),
  route<void>()(
    "DELETE /api/projects/:project/conversations/:conversation/queue/:submission",
    { ...conversation, submission: PARAMS.submission },
    undefined,
    204,
  ),
  route<void>()(
    "POST /api/projects/:project/conversations/:conversation/queue/:submission/steer",
    { ...conversation, submission: PARAMS.submission },
    undefined,
    204,
  ),
  route<Question>()("GET /api/projects/:project/questions/:question", question, undefined),
  route<void>()(
    "POST /api/projects/:project/questions/:question/answer",
    question,
    body({ answer: str(), answers: opt(arr(str())) }),
    204,
  ),
  route<JobLogView>()("GET /api/projects/:project/jobs/:job/log", job, undefined),
  route<void>()("POST /api/projects/:project/jobs/:job/kill", job, undefined, 204),
  route<{ files: MemoryFileEntry[] }>()(
    "GET /api/projects/:project/memory/files",
    project,
    undefined,
  ),
  route<MemoryFileView>()(
    "GET /api/projects/:project/memory/files/:file",
    { ...project, ...file },
    undefined,
  ),
  route<{ changes: MemoryChange[] }>()(
    "GET /api/projects/:project/memory/changes",
    project,
    undefined,
  ),
  route<MemoryChangeDetail>()(
    "GET /api/projects/:project/memory/changes/:change",
    { ...project, ...change },
    undefined,
  ),
  route<MemoryChange>()(
    "POST /api/projects/:project/memory/changes/:change/undo",
    { ...project, ...change },
    undefined,
  ),
  route<{ files: MemoryFileEntry[] }>()("GET /api/memory/files", {}, undefined),
  route<MemoryFileView>()("GET /api/memory/files/:file", file, undefined),
  route<{ changes: MemoryChange[] }>()("GET /api/memory/changes", {}, undefined),
  route<MemoryChangeDetail>()("GET /api/memory/changes/:change", change, undefined),
  route<MemoryChange>()("POST /api/memory/changes/:change/undo", change, undefined),
] as const;

type Definitions = (typeof ROUTES)[number];
export type ApiRoutes = { [R in Definitions as R["key"]]: R };
export type RouteKey = keyof ApiRoutes;
export type RouteBody<K extends RouteKey> = ApiRoutes[K]["body"] extends Schema
  ? Static<ApiRoutes[K]["body"]>
  : undefined;
export type RouteResponse<K extends RouteKey> = ApiRoutes[K]["response"];
export type RouteParams<K extends RouteKey> = {
  [P in keyof ApiRoutes[K]["params"]]: ApiRoutes[K]["params"][P] extends Param<infer T> ? T : never;
};
export type ClientParams<K extends RouteKey> = { [P in keyof RouteParams<K>]: string | number };
