import type { ModelDefinition, ProviderConfig } from "../config/models.ts";
import type {
  ConfigIssue,
  ConfigProblem,
  Job,
  MemoryChange,
  MemoryChangeDetail,
  MemoryProposal,
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
} from "../domain/index.ts";

export type ProjectSummary = {
  id: string;
  title: string;
  /** The directories a project covers; the first is the default working directory. */
  workspaces: string[];
  createdAt: number;
  activeAt?: number;
  models?: ModelDefaults;
};

export type DirEntry = { name: string; path: string };

/** A directory listing for the path picker: `path` is the listed dir, `""` for the roots. */
export type DirListing = {
  path: string;
  parent?: string;
  dirs: DirEntry[];
  /** The user's home directory; named on the roots listing only. */
  home?: string;
};

export type EngineView = {
  bootId: string;
  version: string;
  projects: ProjectSummary[];
};

export type ProblemBody = Problem & { status: number; title: string };
export type ApiError = ProblemBody;

export type TicketView = {
  ticket: Ticket;
  stage: TicketStage;
  reports: Report[];
  jobs: Job[];
};

export type BoardRouterView = RunSummary;

export type BoardView = {
  tickets: TicketView[];
  openQuestions: Question[];
  openProposals: Pick<MemoryProposal, "id" | "scope" | "summary" | "source">[];
  router: BoardRouterView;
};
export type MemoryProposalView = MemoryProposal & {
  files: MemoryChangeDetail["files"];
  conflict?: string;
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

export type MemoryFileEntry = {
  path: string;
  size: number;
};

export type MemoryFileView = {
  path: string;
  content: string;
  version: string;
};
export type MemoryMutationView = { file: MemoryFileView | null; change: MemoryChange | null };

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

export type ProviderConfigView = ProviderConfig;

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

export type RoleCapabilityView = {
  role: RoleName;
  /** The role's own extensions, always selected. */
  builtIn: readonly string[];
  /** Extensions the user enabled on top. */
  enabled: readonly string[];
  maxTurns?: number;
};

export type CapabilitiesView = {
  /** Every installed extension that a role can enable: MCP servers. */
  available: { name: string; tools: number }[];
  roles: RoleCapabilityView[];
  mcp: McpServerView[];
  problems: readonly ConfigProblem[];
};

export type EngineInfo = {
  bootId: string;
  version: string;
  port: number;
  pid: number;
  startedAt: number;
};
export type EngineStatus = EngineInfo & EngineView;
