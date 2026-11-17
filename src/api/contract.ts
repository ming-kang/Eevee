import type {
  Job,
  MemoryScope,
  ModelDefaults,
  Question,
  Report,
  RoleName,
  Ticket,
  TicketId,
  TicketStage,
} from "../contracts/index.ts";

export type ProjectSummary = {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
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

export type BoardView = {
  tickets: TicketView[];
  openQuestions: Question[];
};

export type ChatLine = {
  id: number;
  role: "user" | "assistant" | "tool" | "notice" | "reset";
  text: string;
};

export type ConversationView = {
  lines: ChatLine[];
  running: boolean;
  failure?: string;
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

export type McpServerView = {
  name: string;
  /** The extension roles enable: `mcp.<name>`. */
  extension: string;
  state: "disabled" | "connecting" | "connected" | "failed";
  exposure: "deferred" | "direct" | "codemode" | "hidden";
  tools: number;
  error?: string;
};

export type UserExtensionView = { file: string; name?: string; tools: number; error?: string };

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
  problems: readonly string[];
};

type Ok = { ok: true };

export type ApiRoutes = {
  "GET /api/health": { response: Ok };
  "GET /api/status": { response: EngineStatus };
  "POST /api/shutdown": { response: Ok };
  "POST /api/session": { body: { code: string }; response: { token: string } };
  "POST /api/session/code": { response: { code: string } };
  "GET /api/models": { response: { catalog: string } };
  "POST /api/settings/models": {
    body: { role?: RoleName | "default"; provider: string; modelId: string };
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
  "GET /api/projects/:project/board": { response: BoardView };
  "GET /api/projects/:project/conversation": { response: ConversationView };
  "GET /api/projects/:project/usage": { response: UsageView };
  "GET /api/projects/:project/memory/:scope/log": { response: { commits: MemoryCommitView[] } };
  "GET /api/projects/:project/memory/:scope/commits/:commit": { response: { diff: string } };
  "GET /api/projects/:project/memory/:scope/diff": { response: { diff: string } };
  "POST /api/projects/:project/memory/:scope/revert": {
    body: { commit: string };
    response: Ok;
  };
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

export type ApiError = { error: { code: string; message: string } };

/** Memory scopes as they appear in paths. */
export const MEMORY_SCOPES: readonly MemoryScope[] = ["project", "global"];

export const TOKEN_HEADER = "x-eevee-token";
