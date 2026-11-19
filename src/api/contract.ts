import type { Static } from "@earendil-works/pi-schema";
import type {
  ConfigIssue,
  ConfigProblem,
  Job,
  MemoryScope,
  ModelChoice,
  ModelDefaults,
  Problem,
  Question,
  Report,
  RoleName,
  RunFailureView,
  RunSummary,
  ThinkingLevel,
  Ticket,
  TicketId,
  TicketStage,
} from "../contracts/index.ts";
import type { ModelDefinition, ProviderConfig } from "../contracts/models-config.ts";
import type { BodySchema } from "./bodies.ts";

export type ProjectSummary = {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
  activeAt?: number;
  models?: ModelDefaults;
};

export type EngineStatus = {
  bootId: string;
  version: string;
  port: number;
  projects: ProjectSummary[];
};

export type TicketView = {
  ticket: Ticket;
  stage: TicketStage;
  reports: Report[];
  /** Background jobs still running for it. */
  jobs: Job[];
};

/** Whether the Router runs, and how its last run failed unless it was interrupted or reset on purpose. */
export type BoardRouterView = RunSummary;

export type BoardView = {
  tickets: TicketView[];
  openQuestions: Question[];
  router: BoardRouterView;
};

export type ChatLine = {
  id: number;
  role: "user" | "assistant" | "tool" | "notice" | "reset";
  text: string;
};

export type ConversationView = {
  lines: ChatLine[];
  running: boolean;
  failure?: RunFailureView;
};

/** Spend, summed over one or more conversations. */
export type UsageSummary = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Best available total cost: billed where the provider reports it, else the catalog estimate. */
  cost: number;
};

export type UsageView = {
  total: UsageSummary;
  /** By `provider/modelId`. */
  models: Record<string, UsageSummary>;
  router: UsageSummary;
  tickets: { ticketId: TicketId; title: string; usage: UsageSummary }[];
};

export type MemoryCommitView = { commit: string; at: string; subject: string };

export type MemoryFileEntry = {
  path: string;
  size: number;
};

export type MemoryFileView = {
  path: string;
  content: string;
};

export type JobLogView = {
  job: Job;
  content: string;
  truncated: boolean;
};

export type ModelSpecView = {
  provider: string;
  modelId: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** The thinking levels it takes, least to most; `["off"]` when it does not reason. */
  thinkingLevels: ThinkingLevel[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cacheShortSeconds?: number;
};

export type ModelProviderView = {
  id: string;
  name: string;
  configured: boolean;
  authType?: "api_key" | "oauth";
  source?: string;
  /** models.json adds or changes it. */
  custom: boolean;
  /** pi-ai brings it; models.json can only change it. */
  builtIn: boolean;
  /** A built-in provider's own endpoint, before models.json changes it. */
  defaultBaseUrl?: string;
  modelCount: number;
};

/** A models.json provider entry, as written; the Engine checks it against the schema. */
export type ProviderConfigView = ProviderConfig;

/** One model entry of a provider, as written. */
export type ProviderModelConfig = ModelDefinition;

/**
 * What to ask an endpoint for its models with. `key` may be a literal or an environment variable reference;
 * without it, the credentials of `provider`, when it exists, are used.
 */
export type ProbeModelsInput = {
  provider?: string;
  baseUrl: string;
  api?: string;
  key?: string;
  headers?: Record<string, string>;
};

/** A model an endpoint lists, with the models.json fields it declared. */
export type ProbedModelView = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
};

/** A model pi-ai brings, with the fields a models.json entry can copy from it. */
export type BuiltinModelView = {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  /** USD per million tokens. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** It also prices by input size; those tiers are not copied. */
  costTiers: boolean;
};

export type ModelsView = {
  catalog: string;
  defaults: ModelDefaults;
  routerModel?: ModelChoice;
  providers: ModelProviderView[];
  available: ModelSpecView[];
  profiles: string;
  problems: readonly ConfigProblem[];
};

export type McpServerView = {
  name: string;
  /** The extension roles enable: `mcp.<name>`. */
  extension: string;
  state: "disabled" | "connecting" | "connected" | "failed";
  exposure: "deferred" | "direct" | "codemode" | "hidden";
  tools: number;
  error?: ConfigIssue;
};

export type UserExtensionView = { file: string; name?: string; tools: number; error?: ConfigIssue };

export type RoleCapabilityView = {
  role: RoleName;
  /** The role's own extensions, always selected. */
  builtIn: readonly string[];
  /** Extensions the user enabled on top. */
  enabled: readonly string[];
  maxTurns?: number;
};

export type CapabilitiesView = {
  /** Every installed extension that a role can enable: MCP servers and user extensions. */
  available: { name: string; tools: number }[];
  roles: RoleCapabilityView[];
  mcp: McpServerView[];
  userExtensions: UserExtensionView[];
  problems: readonly ConfigProblem[];
};

type Ok = { ok: true };

export type ApiRoutes = {
  "GET /api/health": { response: Ok };
  "GET /api/status": { response: EngineStatus };
  "POST /api/shutdown": { response: Ok };
  "POST /api/session": {
    body: Static<BodySchema<"POST /api/session">>;
    response: { token: string };
  };
  "POST /api/session/code": { response: { code: string } };
  "GET /api/models": { response: ModelsView };
  "POST /api/settings/models": {
    body: Static<BodySchema<"POST /api/settings/models">>;
    response: Ok;
  };
  "POST /api/auth/:provider": {
    body: Static<BodySchema<"POST /api/auth/:provider">>;
    response: Ok;
  };
  "DELETE /api/auth/:provider": { response: Ok };
  "GET /api/models/config": { response: { providers: Record<string, ProviderConfigView> } };
  "PUT /api/models/providers/:provider": {
    body: Static<BodySchema<"PUT /api/models/providers/:provider">>;
    response: ModelsView;
  };
  "DELETE /api/models/providers/:provider": { response: ModelsView };
  "POST /api/models/builtin": {
    body: Static<BodySchema<"POST /api/models/builtin">>;
    response: { models: BuiltinModelView[] };
  };
  "POST /api/models/probe": {
    body: Static<BodySchema<"POST /api/models/probe">>;
    response: { models: ProbedModelView[]; truncated: boolean };
  };
  "GET /api/capabilities": { response: CapabilitiesView };
  "POST /api/capabilities/roles/:role": {
    body: Static<BodySchema<"POST /api/capabilities/roles/:role">>;
    response: CapabilitiesView;
  };
  "POST /api/mcp/reload": { response: CapabilitiesView };
  /** mcp.json's server entries as written: the `mcpServers` shape other MCP clients share. */
  "GET /api/mcp/config": { response: { servers: Record<string, Record<string, unknown>> } };
  "PUT /api/mcp/servers/:server": {
    body: Static<BodySchema<"PUT /api/mcp/servers/:server">>;
    response: CapabilitiesView;
  };
  "DELETE /api/mcp/servers/:server": { response: CapabilitiesView };
  "POST /api/projects": {
    body: Static<BodySchema<"POST /api/projects">>;
    response: ProjectSummary;
  };
  "POST /api/projects/:project/models": {
    body: Static<BodySchema<"POST /api/projects/:project/models">>;
    response: ProjectSummary;
  };
  "GET /api/projects/:project/board": { response: BoardView };
  "GET /api/projects/:project/conversation": { response: ConversationView };
  "GET /api/projects/:project/usage": { response: UsageView };
  "GET /api/projects/:project/memory/:scope/log": { response: { commits: MemoryCommitView[] } };
  "GET /api/projects/:project/memory/:scope/files": { response: { files: MemoryFileEntry[] } };
  "GET /api/projects/:project/memory/:scope/files/:file": { response: MemoryFileView };
  "GET /api/projects/:project/memory/:scope/commits/:commit": { response: { diff: string } };
  "GET /api/projects/:project/memory/:scope/diff": { response: { diff: string } };
  "POST /api/projects/:project/memory/:scope/revert": {
    body: Static<BodySchema<"POST /api/projects/:project/memory/:scope/revert">>;
    response: Ok;
  };
  "GET /api/projects/:project/jobs/:job/log": { response: JobLogView };
  "POST /api/projects/:project/jobs/:job/kill": { response: Ok };
  "POST /api/projects/:project/conversation/retry": { response: Ok };
  "POST /api/projects/:project/messages": {
    body: Static<BodySchema<"POST /api/projects/:project/messages">>;
    response: Ok;
  };
  "GET /api/projects/:project/tickets/:ticket/conversation": { response: ConversationView };
  "POST /api/projects/:project/tickets/:ticket/retry": { response: Ok };
  "POST /api/projects/:project/tickets/:ticket/messages": {
    body: Static<BodySchema<"POST /api/projects/:project/tickets/:ticket/messages">>;
    response: Ok;
  };
  "POST /api/projects/:project/tickets/:ticket/interrupt": { response: Ok };
  "POST /api/projects/:project/questions/:question/answer": {
    body: Static<BodySchema<"POST /api/projects/:project/questions/:question/answer">>;
    response: Ok;
  };
};

export type RouteKey = keyof ApiRoutes;
export type RouteBody<K extends RouteKey> = ApiRoutes[K] extends { body: infer B } ? B : undefined;
export type RouteResponse<K extends RouteKey> = ApiRoutes[K]["response"];

type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;
type PathOf<K extends RouteKey> = K extends `${string} ${infer P}` ? P : never;
export type RouteParams<K extends RouteKey> = Record<ParamNames<PathOf<K>>, string>;

/** A refusal as it travels: the Problem's data, plus the Engine's wording for clients that just print it. */
export type ProblemBody = Problem & { message: string };

export type ApiError = { error: ProblemBody };

/** Memory scopes as they appear in paths. */
export const MEMORY_SCOPES: readonly MemoryScope[] = ["project", "global"];

export const TOKEN_HEADER = "x-eevee-token";
