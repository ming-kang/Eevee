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
  custom: boolean;
  modelCount: number;
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
  "POST /api/session": { body: { code: string }; response: { token: string } };
  "POST /api/session/code": { response: { code: string } };
  "GET /api/models": { response: ModelsView };
  "POST /api/settings/models": {
    body: { role?: RoleName | "default" } & ModelChoice;
    response: Ok;
  };
  "POST /api/auth/:provider": { body: { key: string }; response: Ok };
  "GET /api/capabilities": { response: CapabilitiesView };
  "POST /api/capabilities/roles/:role": {
    body: { extensions?: string[]; maxTurns?: number | null };
    response: CapabilitiesView;
  };
  "POST /api/mcp/reload": { response: CapabilitiesView };
  "POST /api/projects": { body: { title: string; workspace: string }; response: ProjectSummary };
  "POST /api/projects/:project/models": {
    /** `null` drops the project's own choice, so the role follows the settings again. */
    body: { role?: RoleName | "default"; model: ModelChoice | null };
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
    body: { commit: string };
    response: Ok;
  };
  "GET /api/projects/:project/jobs/:job/log": { response: JobLogView };
  "POST /api/projects/:project/jobs/:job/kill": { response: Ok };
  "POST /api/projects/:project/conversation/retry": { response: Ok };
  "POST /api/projects/:project/messages": { body: { text: string }; response: Ok };
  "GET /api/projects/:project/tickets/:ticket/conversation": { response: ConversationView };
  "POST /api/projects/:project/tickets/:ticket/retry": { response: Ok };
  "POST /api/projects/:project/tickets/:ticket/messages": {
    body: { text: string; mode?: "steer" | "followUp" };
    response: Ok;
  };
  "POST /api/projects/:project/tickets/:ticket/interrupt": { response: Ok };
  "POST /api/projects/:project/questions/:question/answer": {
    body: { answer: string };
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
