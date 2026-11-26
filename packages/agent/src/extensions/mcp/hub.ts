import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  defineExtension,
  type Extension,
  type PromptInput,
  type Registry,
} from "@earendil-works/pi-durable";
import {
  type AuthProvider,
  type CallToolResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  McpAbortError,
  McpAuthRequiredError,
  McpClient,
  McpError,
  McpHttpError,
  type McpOutputSaver,
  type McpRequestOptions,
  type Tool as McpTool,
  type McpTransport,
  mcpNamespace,
  mcpServerSummary,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type Root,
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import {
  type McpAuthProvider,
  McpOAuthAuthorizationRequiredError,
  type OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";
import {
  DEFAULT_MCP_EXPOSURE,
  getMcpToolExposure,
  isMcpServerEnabledForRole,
  type McpExposure,
  type McpServerEntry,
  resolveServerEnv,
  resolveServerHeaders,
} from "./config.ts";
import { McpServerLog } from "./log.ts";
import { createEeveeMcpAuthProvider, type McpOAuthCredentialStore } from "./oauth.ts";
import {
  createMcpResourceTools,
  type McpResourceHost,
  type McpResourceServerInfo,
} from "./resources.ts";
import { adaptMcpTools } from "./tools.ts";

export const MCP_EXTENSION = "eevee.mcp";
export const MCP_SERVER_EXTENSION_PREFIX = "eevee.mcp.";

export function mcpServerExtensionName(server: string): string {
  return `${MCP_SERVER_EXTENSION_PREFIX}${server}`;
}

export type ResolvedMcpServerRoles = {
  readonly router: boolean;
  readonly worker: boolean;
};

const mcpServerExtensionRoles = new WeakMap<Extension, ResolvedMcpServerRoles>();

export function getMcpServerExtensionRoles(
  extension: Extension,
): ResolvedMcpServerRoles | undefined {
  return mcpServerExtensionRoles.get(extension);
}

export type McpServerStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "auth_required"
  | "degraded"
  | "disconnected"
  | "failed"
  | "disabled"
  | "closed";

export type McpServerToolSummary = {
  readonly name: string;
  readonly description?: string;
  readonly exposure: McpExposure;
};

export type McpServerSnapshot = {
  readonly name: string;
  readonly status: McpServerStatus;
  readonly enabled: boolean;
  readonly description?: string;
  readonly instructions?: string;
  readonly toolCount: number;
  readonly error?: string;
  readonly transport: "stdio" | "http";
  readonly roles: ResolvedMcpServerRoles;
  readonly exposure: McpExposure;
  readonly hasResources: boolean;
  readonly authRequired?: boolean;
  readonly tools?: readonly McpServerToolSummary[];
  readonly recentLogs?: readonly string[];
};

export type McpHubOptions = {
  readonly servers?: readonly McpServerEntry[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  readonly defaultTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly transientRetryDelayMs?: number;
  readonly roots?: readonly string[] | (() => readonly string[]);
  readonly logPath?: string;
  readonly oauthStore?: McpOAuthCredentialStore;
  readonly onAuthChallenge?: (serverName: string, challenge: OAuthChallenge) => void;
  readonly authProvider?: AuthProvider | ((entry: McpServerEntry) => AuthProvider | undefined);
  readonly createTransport?: (
    entry: McpServerEntry,
    cwd: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => McpTransport;
  readonly saveOutput?: McpOutputSaver;
};

export type McpHubStartOptions = {
  readonly awaitConnections?: boolean;
};

type ServerRuntime = {
  entry: McpServerEntry;
  status: McpServerStatus;
  retired: boolean;
  error?: string;
  authRequired?: boolean;
  lastChallenge?: OAuthChallenge;
  instructions?: string;
  tools: McpTool[];
  client?: McpClient;
  pendingClient?: McpClient;
  activeAuthProvider?: AuthProvider;
  connecting?: Promise<McpClient>;
  closePromise?: Promise<void>;
  reconnecting?: Promise<void>;
};

type RegistryBinding = {
  readonly registry: Registry;
  installed: Set<string>;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 150;
const DEFAULT_CLIENT_INFO = { name: "eevee", version: "0.0.1" } as const;

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return (text.split("\n", 1)[0] ?? "").trimEnd();
}

function isEnabled(entry: McpServerEntry): boolean {
  return entry.config.enabled !== false;
}

function createRuntime(entry: McpServerEntry): ServerRuntime {
  return {
    entry,
    status: isEnabled(entry) ? "idle" : "disabled",
    retired: false,
    tools: [],
  };
}

function isAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError
  );
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return errorCodeOf(error.cause);
  return undefined;
}

function isTransientError(error: unknown): boolean {
  if (isAuthRequiredError(error)) return false;
  if (error instanceof McpAbortError) return false;
  if (error instanceof McpError) return false;
  if (error instanceof McpHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof TypeError) return true;
  const code = errorCodeOf(error);
  return code !== undefined && (NETWORK_ERROR_CODES.has(code) || code.startsWith("UND_ERR"));
}

function hasSettledMethod(
  provider: AuthProvider | undefined,
): provider is AuthProvider & McpAuthProvider {
  return (
    provider !== undefined &&
    "settled" in provider &&
    typeof (provider as { settled?: unknown }).settled === "function"
  );
}

function validateEntries(entries: readonly McpServerEntry[]): readonly McpServerEntry[] {
  const names = new Set<string>();
  const namespaces = new Map<string, string>();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`duplicate MCP server "${entry.name}"`);
    names.add(entry.name);
    const namespace = mcpNamespace(entry.name);
    const conflicting = namespaces.get(namespace);
    if (conflicting !== undefined) {
      throw new Error(
        `MCP server "${entry.name}" conflicts with "${conflicting}": both use namespace "${namespace}"`,
      );
    }
    namespaces.set(namespace, entry.name);
  }
  return entries;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sameConfig(left: McpServerEntry, right: McpServerEntry): boolean {
  return stableJson(left.config) === stableJson(right.config);
}

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function toMcpRoots(dirs: readonly string[], cwd: string): Root[] {
  const seen = new Set<string>();
  const roots: Root[] = [];
  for (const dir of dirs) {
    const abs = resolve(cwd, expandHome(dir));
    const uri = pathToFileURL(abs).href;
    if (seen.has(uri)) continue;
    seen.add(uri);
    const name = basename(abs) || abs;
    roots.push({ uri, name });
  }
  return roots;
}

function createDefaultTransport(
  entry: McpServerEntry,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  authProvider: AuthProvider | undefined,
  onStderr: (chunk: string) => void,
): McpTransport {
  const { config } = entry;
  if ("url" in config) {
    return new StreamableHttpTransport({
      url: config.url,
      headers: resolveServerHeaders(config.headers, env),
      authProvider,
    });
  }
  const configuredEnv = resolveServerEnv(config.env, env);
  return new StdioTransport({
    command: expandHome(config.command),
    args: config.args?.map(expandHome),
    cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
    env: { ...definedEnv(env), ...configuredEnv },
    inheritEnv: false,
    stderr: "pipe",
    onStderr,
  });
}

function createDefaultOutputSaver(): McpOutputSaver {
  let directory: Promise<string> | undefined;
  return async (data, extension) => {
    directory ??= mkdtemp(join(tmpdir(), "eevee-mcp-"));
    const dir = await directory;
    const safeExtension = /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension : ".bin";
    const path = join(dir, `output-${randomUUID()}${safeExtension}`);
    await writeFile(path, data, { mode: 0o600 });
    return path;
  };
}

function configuredExposures(entry: McpServerEntry): Set<string> {
  return new Set([
    entry.config.exposure ?? DEFAULT_MCP_EXPOSURE,
    ...Object.values(entry.config.toolExposure ?? {}),
  ]);
}

function exposureText(entry: McpServerEntry): string {
  const exposures = configuredExposures(entry);
  return ["direct", "deferred", "codemode", "hidden"]
    .filter((exposure) => exposures.has(exposure))
    .join("+");
}

function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new McpAbortError(String(signal.reason)),
    );
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(
        signal?.reason instanceof Error
          ? signal.reason
          : new McpAbortError(String(signal?.reason ?? "Aborted")),
      );
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new Error(timeoutMessage));
      }, timeoutMs);
      timer.unref?.();
    }

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

export class McpHub implements McpResourceHost {
  private servers = new Map<string, ServerRuntime>();
  private readonly cwd: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly clientInfo: { readonly name: string; readonly version: string };
  private readonly defaultTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly transientRetryDelayMs: number;
  private rootsSource?: readonly string[] | (() => readonly string[]);
  private readonly log: McpServerLog;
  private readonly oauthStore?: McpOAuthCredentialStore;
  private readonly onAuthChallenge?: (serverName: string, challenge: OAuthChallenge) => void;
  private readonly authProvider?:
    | AuthProvider
    | ((entry: McpServerEntry) => AuthProvider | undefined);
  private readonly createTransport?: (
    entry: McpServerEntry,
    cwd: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => McpTransport;
  private readonly saveOutput: McpOutputSaver;
  private readonly listeners = new Set<() => void>();
  private readonly bindings = new Set<RegistryBinding>();
  private reloadChain: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(options: McpHubOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.transientRetryDelayMs = options.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;
    this.rootsSource = options.roots;
    this.log = new McpServerLog({ logPath: options.logPath });
    this.oauthStore = options.oauthStore;
    this.onAuthChallenge = options.onAuthChallenge;
    this.authProvider = options.authProvider;
    this.createTransport = options.createTransport;
    this.saveOutput = options.saveOutput ?? createDefaultOutputSaver();
    for (const entry of validateEntries(options.servers ?? [])) {
      this.servers.set(entry.name, createRuntime(entry));
    }
  }

  async start(options: McpHubStartOptions = {}): Promise<void> {
    if (this.closed) throw new Error("MCP hub is closed");
    const starts = [...this.servers.values()]
      .filter((runtime) => isEnabled(runtime.entry))
      .map((runtime) => this.connectRuntime(runtime, true).catch(() => undefined));
    if (options.awaitConnections === false) return;
    await Promise.allSettled(starts);
  }

  startBackground(): void {
    if (this.closed) throw new Error("MCP hub is closed");
    void this.start({ awaitConnections: false });
  }

  async ensureServerReady(
    name: string,
    timeoutMs: number = this.readyTimeoutMs,
    signal?: AbortSignal,
  ): Promise<void> {
    const runtime = this.servers.get(name);
    if (runtime === undefined) throw new Error(`Unknown MCP server "${name}"`);
    await this.ensureRuntimeReady(runtime, timeoutMs, signal);
  }

  async updateRoots(roots: readonly string[]): Promise<void> {
    this.rootsSource = [...roots];
    if (this.closed) return;
    const connected = [...this.servers.values()].filter(
      (runtime) =>
        (runtime.status === "connected" || runtime.status === "degraded") &&
        runtime.client?.connectionState === "connected",
    );
    await Promise.allSettled(
      connected.map((runtime) => runtime.client?.notify("notifications/roots/list_changed")),
    );
  }

  getServerLogs(name: string): readonly string[] {
    return this.log.getServerLogs(name);
  }

  getAuthChallenge(name: string): OAuthChallenge | undefined {
    return this.servers.get(name)?.lastChallenge;
  }

  async reload(servers: readonly McpServerEntry[]): Promise<void> {
    if (this.closed) throw new Error("MCP hub is closed");
    const entries = validateEntries(servers);
    const run = this.reloadChain.then(() => this.applyReload(entries));
    this.reloadChain = run.catch(() => undefined);
    await run;
  }

  private async applyReload(entries: readonly McpServerEntry[]): Promise<void> {
    if (this.closed) throw new Error("MCP hub is closed");
    const previous = this.servers;
    const next = new Map<string, ServerRuntime>();
    const closing: Promise<void>[] = [];
    const retained = new Set<string>();

    for (const entry of entries) {
      const existing = previous.get(entry.name);
      if (existing !== undefined && sameConfig(existing.entry, entry)) {
        existing.entry = entry;
        next.set(entry.name, existing);
        retained.add(entry.name);
      } else {
        if (existing !== undefined) {
          existing.retired = true;
          closing.push(this.closeRuntime(existing));
        }
        next.set(entry.name, createRuntime(entry));
      }
    }
    for (const [name, runtime] of previous) {
      if (!retained.has(name) && !next.has(name)) {
        runtime.retired = true;
        closing.push(this.closeRuntime(runtime));
      }
    }

    await Promise.all(closing);
    if (this.closed) throw new Error("MCP hub is closed");
    this.servers = next;
    this.notify();
    const starts = [...next.values()]
      .filter((runtime) => isEnabled(runtime.entry))
      .map((runtime) => this.connectRuntime(runtime, true).then(() => undefined));
    await Promise.allSettled(starts);
  }

  async reconnect(serverName?: string): Promise<McpServerSnapshot[]> {
    if (this.closed) throw new Error("MCP hub is closed");
    if (serverName !== undefined) {
      const runtime = this.servers.get(serverName);
      if (runtime === undefined) throw new Error(`Unknown MCP server "${serverName}"`);
      if (!isEnabled(runtime.entry)) throw new Error(`MCP server "${serverName}" is disabled`);
      await this.reconnectRuntime(runtime);
      return this.status();
    }
    const enabled = [...this.servers.values()].filter((runtime) => isEnabled(runtime.entry));
    await Promise.allSettled(enabled.map((runtime) => this.reconnectRuntime(runtime)));
    return this.status();
  }

  private async reconnectRuntime(runtime: ServerRuntime): Promise<void> {
    if (this.closed || runtime.retired) return;
    if (runtime.reconnecting !== undefined) return runtime.reconnecting;
    const run = (async () => {
      await this.closeRuntime(runtime);
      if (this.closed || runtime.retired || this.servers.get(runtime.entry.name) !== runtime)
        return;
      runtime.closePromise = undefined;
      runtime.status = isEnabled(runtime.entry) ? "idle" : "disabled";
      runtime.tools = [];
      runtime.instructions = undefined;
      runtime.error = undefined;
      runtime.authRequired = false;
      await this.connectRuntime(runtime, true).catch(() => undefined);
    })();
    runtime.reconnecting = run;
    try {
      await run;
    } finally {
      if (runtime.reconnecting === run) runtime.reconnecting = undefined;
    }
  }

  status(): McpServerSnapshot[] {
    return [...this.servers.values()].map((runtime) => {
      const recentLogs = this.log.getServerLogs(runtime.entry.name);
      return {
        name: runtime.entry.name,
        status: runtime.status,
        enabled: isEnabled(runtime.entry),
        ...(runtime.entry.config.description === undefined
          ? {}
          : { description: runtime.entry.config.description }),
        ...(runtime.instructions === undefined ? {} : { instructions: runtime.instructions }),
        toolCount: runtime.tools.length,
        ...(runtime.error === undefined ? {} : { error: runtime.error }),
        transport: "url" in runtime.entry.config ? "http" : "stdio",
        roles: {
          router: isMcpServerEnabledForRole(runtime.entry.config, "router"),
          worker: isMcpServerEnabledForRole(runtime.entry.config, "worker"),
        },
        exposure: runtime.entry.config.exposure ?? DEFAULT_MCP_EXPOSURE,
        hasResources: Boolean(runtime.client?.serverCapabilities?.resources),
        ...(runtime.authRequired ? { authRequired: true } : {}),
        ...(runtime.tools.length > 0 ||
        runtime.status === "connected" ||
        runtime.status === "degraded"
          ? {
              tools: runtime.tools.map((tool) => ({
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                exposure: getMcpToolExposure(runtime.entry.config, tool.name),
              })),
            }
          : {}),
        ...(recentLogs.length > 0 ? { recentLogs } : {}),
      };
    });
  }

  listResourceServers(): readonly McpResourceServerInfo[] {
    return [...this.servers.values()]
      .filter((runtime) => isEnabled(runtime.entry))
      .map((runtime) => ({
        name: runtime.entry.name,
        namespace: mcpNamespace(runtime.entry.name),
        extensionName: mcpServerExtensionName(runtime.entry.name),
        hasResources: Boolean(runtime.client?.serverCapabilities?.resources),
        status: runtime.status,
      }));
  }

  async listResources(server: string, options: McpRequestOptions = {}): Promise<Resource[]> {
    return this.runResourceRead(server, options, (client, reqOptions) =>
      client.listResources(reqOptions),
    );
  }

  async listResourcesPage(
    server: string,
    cursor?: string,
    options: McpRequestOptions = {},
  ): Promise<ListResourcesResult> {
    return this.runResourceRead(server, options, (client, reqOptions) =>
      client.listResourcesPage(cursor, reqOptions),
    );
  }

  async listResourceTemplates(
    server: string,
    options: McpRequestOptions = {},
  ): Promise<ResourceTemplate[]> {
    return this.runResourceRead(server, options, (client, reqOptions) =>
      client.listResourceTemplates(reqOptions),
    );
  }

  async listResourceTemplatesPage(
    server: string,
    cursor?: string,
    options: McpRequestOptions = {},
  ): Promise<ListResourceTemplatesResult> {
    return this.runResourceRead(server, options, (client, reqOptions) =>
      client.listResourceTemplatesPage(cursor, reqOptions),
    );
  }

  async readResource(
    server: string,
    uri: string,
    options: McpRequestOptions = {},
  ): Promise<ReadResourceResult> {
    return this.runResourceRead(server, options, (client, reqOptions) =>
      client.readResource(uri, reqOptions),
    );
  }

  extension(): Extension {
    const hasResourceServers = [...this.servers.values()].some(
      (runtime) =>
        isEnabled(runtime.entry) && Boolean(runtime.client?.serverCapabilities?.resources),
    );
    return defineExtension({
      name: MCP_EXTENSION,
      ...(hasResourceServers
        ? {
            tools: createMcpResourceTools({
              host: this,
              saveOutput: this.saveOutput,
              timeoutMs: this.defaultTimeoutMs,
            }),
          }
        : {}),
      sections: [
        {
          key: "mcp_servers",
          render: (input) => this.renderServersSection(input),
        },
      ],
    });
  }

  serverExtensions(): Extension[] {
    return [...this.servers.values()]
      .filter((runtime) => isEnabled(runtime.entry))
      .map((runtime) => {
        const entry = runtime.entry;
        const summary = mcpServerSummary(entry.config.description, runtime.instructions);
        const instructions = runtime.instructions;
        const timeoutMs = this.timeoutMsOf(entry);
        const extension = defineExtension({
          name: mcpServerExtensionName(entry.name),
          namespace: {
            name: mcpNamespace(entry.name),
            description: summary || `MCP server ${entry.name}`,
            ...(instructions === undefined ? {} : { instructions }),
          },
          tools: adaptMcpTools({
            server: entry.name,
            tools: runtime.tools,
            config: entry.config,
            timeoutMs,
            callTool: (tool, args, options) => this.callTool(entry.name, tool, args, options),
            saveOutput: this.saveOutput,
          }),
        });
        mcpServerExtensionRoles.set(extension, {
          router: isMcpServerEnabledForRole(entry.config, "router"),
          worker: isMcpServerEnabledForRole(entry.config, "worker"),
        });
        return extension;
      });
  }

  serverExtensionNames(): string[] {
    return [...this.servers.values()]
      .filter((runtime) => isEnabled(runtime.entry))
      .map((runtime) => mcpServerExtensionName(runtime.entry.name));
  }

  extensions(): Extension[] {
    return [this.extension(), ...this.serverExtensions()];
  }

  bindRegistry(registry: Registry): () => void {
    const binding: RegistryBinding = { registry, installed: new Set() };
    this.bindings.add(binding);
    this.publishTo(binding);
    return () => {
      if (!this.bindings.delete(binding)) return;
      for (const name of binding.installed) registry.uninstall({ name });
      binding.installed.clear();
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    for (const runtime of this.servers.values()) {
      runtime.retired = true;
    }
    this.closePromise = (async () => {
      await Promise.all([...this.servers.values()].map((runtime) => this.closeRuntime(runtime)));
      await this.log.close();
      this.notify();
      this.listeners.clear();
    })();
    return this.closePromise;
  }

  private getConfiguredRoots(): readonly string[] {
    if (this.rootsSource === undefined) return [];
    return typeof this.rootsSource === "function" ? this.rootsSource() : this.rootsSource;
  }

  private authProviderOf(runtime: ServerRuntime): AuthProvider | undefined {
    const { entry } = runtime;
    if (this.authProvider !== undefined) {
      return typeof this.authProvider === "function" ? this.authProvider(entry) : this.authProvider;
    }
    if (this.oauthStore !== undefined && "url" in entry.config) {
      const serverUrl = entry.config.url;
      return createEeveeMcpAuthProvider({
        name: entry.name,
        serverUrl,
        store: this.oauthStore,
        settings: () => ("url" in runtime.entry.config ? runtime.entry.config.oauth : undefined),
        env: this.env,
        onChallenge: (challenge) => {
          runtime.lastChallenge = challenge;
          this.onAuthChallenge?.(entry.name, challenge);
        },
      });
    }
    return undefined;
  }

  private timeoutMsOf(entry: McpServerEntry): number {
    return entry.config.timeout !== undefined ? entry.config.timeout * 1000 : this.defaultTimeoutMs;
  }

  private renderServersSection(input?: PromptInput): string | undefined {
    const activeExtensions =
      input?.agent?.extensions === undefined
        ? undefined
        : new Set(input.agent.extensions.map((ext) => ext.name));
    const servers = [...this.servers.values()].filter(
      (runtime) =>
        isEnabled(runtime.entry) &&
        (activeExtensions === undefined ||
          activeExtensions.has(mcpServerExtensionName(runtime.entry.name))),
    );
    if (servers.length === 0) return undefined;
    const exposures = new Set(
      servers.flatMap((runtime) => [...configuredExposures(runtime.entry)]),
    );
    const guidance = ["MCP servers available to this conversation."];
    if (exposures.has("deferred")) {
      guidance.push(
        "Deferred MCP tools are not offered initially; use tool_search to discover and load them.",
      );
    }
    if (exposures.has("codemode")) {
      guidance.push(
        "Codemode MCP tools are callable only from codemode scripts; use searchTools() or describeNamespace() there to discover them.",
      );
    }
    const lines = servers.map((runtime) => {
      const entry = runtime.entry;
      const namespace = mcpNamespace(entry.name);
      const exposure = exposureText(entry);
      const summary = mcpServerSummary(entry.config.description, runtime.instructions);
      const hasResources = Boolean(runtime.client?.serverCapabilities?.resources);
      let state: string;
      if (runtime.status === "connected" || runtime.status === "degraded") {
        const resourceNote = hasResources ? ", resources" : "";
        const degradedNote =
          runtime.status === "degraded" && runtime.error !== undefined
            ? `, degraded: ${firstLine(runtime.error)}`
            : "";
        state = `${runtime.status}, ${runtime.tools.length} tool${runtime.tools.length === 1 ? "" : "s"}${resourceNote}${degradedNote}`;
      } else if (runtime.status === "auth_required") {
        state = "auth required";
      } else if (runtime.status === "failed") {
        state = `failed${runtime.error === undefined ? "" : `: ${firstLine(runtime.error)}`}`;
      } else {
        state = runtime.status;
      }
      return `- ${namespace} (${exposure}; ${state})${summary === "" ? "" : `: ${summary}`}`;
    });
    return [...guidance, ...lines].join("\n");
  }

  private publishTo(binding: RegistryBinding): void {
    const desired = this.extensions();
    const names = new Set<string>();
    for (const extension of desired) {
      binding.registry.install(extension);
      names.add(extension.name);
    }
    for (const name of binding.installed) {
      if (!names.has(name)) binding.registry.uninstall({ name });
    }
    binding.installed = names;
  }

  private notify(): void {
    for (const binding of [...this.bindings]) {
      try {
        this.publishTo(binding);
      } catch {
        // A registry may reject an update while it is being torn down; later state changes republish.
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Listener failures must not turn a background server notification into an unhandled error.
      }
    }
  }

  private markAuthRequired(runtime: ServerRuntime, error: unknown): void {
    if (this.closed || runtime.retired || runtime.status === "closed") return;
    runtime.status = "auth_required";
    runtime.authRequired = true;
    runtime.error = errorMessage(error);
    const stale = runtime.client;
    runtime.client = undefined;
    if (stale !== undefined) {
      void stale.close().catch(() => undefined);
    }
    this.notify();
  }

  private connectRuntime(runtime: ServerRuntime, force: boolean): Promise<McpClient> {
    if (this.closed || runtime.retired || runtime.status === "closed") {
      return Promise.reject(new Error(`MCP server "${runtime.entry.name}" is closed`));
    }
    if (!isEnabled(runtime.entry)) {
      return Promise.reject(new Error(`MCP server "${runtime.entry.name}" is disabled`));
    }
    if (
      runtime.client?.connectionState === "connected" &&
      (runtime.status === "connected" || runtime.status === "degraded")
    ) {
      return Promise.resolve(runtime.client);
    }
    if (runtime.client !== undefined && runtime.client.connectionState !== "connected") {
      runtime.client = undefined;
      if (runtime.status === "connected" || runtime.status === "degraded") {
        runtime.status = "disconnected";
      }
    }
    if (runtime.connecting !== undefined) return runtime.connecting;
    if (runtime.status === "auth_required" && !force) {
      return Promise.reject(new McpOAuthAuthorizationRequiredError());
    }
    if (runtime.status === "failed" && !force) {
      return Promise.reject(
        new Error(`MCP server "${runtime.entry.name}" failed: ${runtime.error ?? "unknown error"}`),
      );
    }

    runtime.status = "connecting";
    runtime.error = undefined;
    runtime.authRequired = false;
    this.notify();
    const connecting = (async (): Promise<McpClient> => {
      try {
        return await this.openRuntimeWithRetry(runtime);
      } catch (error) {
        if (!runtime.retired && runtime.status !== "closed" && !this.closed) {
          if (isAuthRequiredError(error)) {
            runtime.status = "auth_required";
            runtime.authRequired = true;
          } else {
            runtime.status = "failed";
            runtime.authRequired = false;
          }
          runtime.error = errorMessage(error);
          this.log.recordDiagnostic(runtime.entry.name, "error", runtime.error);
          this.notify();
        }
        throw error;
      } finally {
        runtime.connecting = undefined;
      }
    })();
    runtime.connecting = connecting;
    return connecting;
  }

  private async openRuntimeWithRetry(runtime: ServerRuntime): Promise<McpClient> {
    const isHttp = "url" in runtime.entry.config;
    try {
      return await this.openRuntime(runtime);
    } catch (error) {
      if (
        !isHttp ||
        !isTransientError(error) ||
        this.closed ||
        runtime.retired ||
        runtime.status === "closed"
      ) {
        throw error;
      }
      this.log.recordDiagnostic(
        runtime.entry.name,
        "warn",
        `Transient HTTP connection error, retrying once: ${errorMessage(error)}`,
      );
      if (this.transientRetryDelayMs > 0) {
        await delay(this.transientRetryDelayMs);
      }
      if (this.closed || runtime.retired || (runtime.status as McpServerStatus) === "closed") {
        throw new Error(`MCP server "${runtime.entry.name}" is closed`);
      }
      return this.openRuntime(runtime);
    }
  }

  private async openRuntime(runtime: ServerRuntime): Promise<McpClient> {
    const entry = runtime.entry;
    if (this.closed || runtime.retired || runtime.status === "closed") {
      throw new Error(`MCP server "${entry.name}" is closed`);
    }
    const timeoutMs = this.timeoutMsOf(entry);
    const client = new McpClient({
      ...this.clientInfo,
      requestTimeoutMs: timeoutMs,
      ...(this.rootsSource === undefined
        ? {}
        : {
            capabilities: { roots: { listChanged: true } },
            roots: () => toMcpRoots(this.getConfiguredRoots(), this.cwd),
          }),
    });
    const authProvider = this.authProviderOf(runtime);
    runtime.pendingClient = client;
    runtime.activeAuthProvider = authProvider;
    try {
      client.onNotification("notifications/tools/list_changed", () => {
        void this.refreshTools(runtime, client);
      });
      client.onNotification("notifications/resources/list_changed", () => {
        if (!runtime.retired && runtime.client === client) this.notify();
      });
      client.onNotification("notifications/message", (params) => {
        this.log.recordNotification(entry.name, params);
      });
      client.onError((error) => {
        this.log.recordDiagnostic(entry.name, "error", errorMessage(error));
      });
      client.onClose(() => this.handleClientClose(runtime, client));
      const transport = this.createTransport
        ? this.createTransport(entry, this.cwd, this.env)
        : createDefaultTransport(entry, this.cwd, this.env, authProvider, (chunk) => {
            this.log.recordStderr(entry.name, chunk);
          });
      await client.connect(transport);
      if (runtime.retired || (runtime.status as McpServerStatus) === "closed" || this.closed) {
        throw new Error(`MCP server "${entry.name}" is closed`);
      }
      const tools = client.serverCapabilities?.tools ? await client.listTools({ timeoutMs }) : [];
      if (runtime.retired || (runtime.status as McpServerStatus) === "closed" || this.closed) {
        throw new Error(`MCP server "${entry.name}" is closed`);
      }
      if (client.connectionState !== "connected") {
        throw new Error(`MCP server "${entry.name}" closed while connecting`);
      }
      runtime.client = client;
      runtime.tools = tools;
      runtime.instructions = client.instructions?.trim() || undefined;
      runtime.status = "connected";
      runtime.error = undefined;
      runtime.authRequired = false;
      this.notify();
      return client;
    } catch (error) {
      this.log.flushStderr(entry.name);
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      if (runtime.pendingClient === client) runtime.pendingClient = undefined;
    }
  }

  private async refreshTools(runtime: ServerRuntime, client: McpClient): Promise<void> {
    if (this.closed || runtime.retired || runtime.client !== client) return;
    let changed = false;
    try {
      const tools = await client.listTools({ timeoutMs: this.timeoutMsOf(runtime.entry) });
      if (
        runtime.retired ||
        runtime.client !== client ||
        (runtime.status !== "connected" && runtime.status !== "degraded")
      ) {
        return;
      }
      runtime.tools = tools;
      runtime.status = "connected";
      runtime.error = undefined;
      changed = true;
    } catch (error) {
      if (
        runtime.retired ||
        runtime.client !== client ||
        (runtime.status !== "connected" && runtime.status !== "degraded")
      ) {
        return;
      }
      if (isAuthRequiredError(error)) {
        this.markAuthRequired(runtime, error);
        return;
      }
      runtime.status = "degraded";
      runtime.error = `Failed to refresh tools: ${errorMessage(error)}`;
      this.log.recordDiagnostic(runtime.entry.name, "warn", runtime.error);
      changed = true;
    } finally {
      if (changed) this.notify();
    }
  }

  private handleClientClose(runtime: ServerRuntime, client: McpClient): void {
    this.log.flushStderr(runtime.entry.name);
    if (
      this.closed ||
      runtime.retired ||
      runtime.status === "closed" ||
      runtime.client !== client
    ) {
      return;
    }
    runtime.client = undefined;
    if (runtime.status !== "connected" && runtime.status !== "degraded") return;
    runtime.status = "disconnected";
    runtime.error = "Connection closed";
    this.notify();
  }

  private async ensureRuntimeReady(
    runtime: ServerRuntime,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<McpClient> {
    if (!isEnabled(runtime.entry)) {
      throw new Error(`MCP server "${runtime.entry.name}" is disabled`);
    }
    if (runtime.retired || runtime.status === "closed" || this.closed) {
      throw new Error(`MCP server "${runtime.entry.name}" is closed`);
    }
    if (
      runtime.client?.connectionState === "connected" &&
      (runtime.status === "connected" || runtime.status === "degraded")
    ) {
      return runtime.client;
    }
    const connectPromise = this.connectRuntime(runtime, false);
    // Keep any background connect failure handled even if this caller's ready timeout fires first.
    connectPromise.catch(() => undefined);
    return raceTimeout(
      connectPromise,
      timeoutMs,
      `Timed out waiting ${timeoutMs}ms for MCP server "${runtime.entry.name}" to become ready`,
      signal,
    );
  }

  private async runResourceRead<T>(
    server: string,
    options: McpRequestOptions,
    fn: (client: McpClient, reqOptions: McpRequestOptions) => Promise<T>,
  ): Promise<T> {
    const runtime = this.servers.get(server);
    if (runtime === undefined) throw new Error(`Unknown MCP server "${server}"`);
    const timeoutMs = options.timeoutMs ?? this.timeoutMsOf(runtime.entry);
    const waitMs = Math.min(timeoutMs, this.readyTimeoutMs);
    const client = await this.ensureRuntimeReady(runtime, waitMs, options.signal);
    if (!client.serverCapabilities?.resources) {
      throw new Error(`MCP server "${server}" does not advertise resources capability`);
    }
    const reqOptions: McpRequestOptions = { ...options, timeoutMs };
    try {
      return await fn(client, reqOptions);
    } catch (error) {
      if (isAuthRequiredError(error)) {
        this.markAuthRequired(runtime, error);
        throw error;
      }
      if (
        !isTransientError(error) ||
        options.signal?.aborted ||
        this.closed ||
        runtime.retired ||
        runtime.status === "closed"
      ) {
        throw error;
      }
      this.log.recordDiagnostic(
        server,
        "warn",
        `Transient resource request error, retrying once: ${errorMessage(error)}`,
      );
      if (this.transientRetryDelayMs > 0) {
        await delay(this.transientRetryDelayMs, undefined, { signal: options.signal });
      }
      const nextClient = await this.ensureRuntimeReady(runtime, waitMs, options.signal);
      try {
        return await fn(nextClient, reqOptions);
      } catch (retryError) {
        if (isAuthRequiredError(retryError)) {
          this.markAuthRequired(runtime, retryError);
        }
        throw retryError;
      }
    }
  }

  private async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: McpRequestOptions,
  ): Promise<CallToolResult> {
    const runtime = this.servers.get(server);
    if (runtime === undefined) throw new Error(`Unknown MCP server "${server}"`);
    const waitMs = Math.min(
      options.timeoutMs ?? this.timeoutMsOf(runtime.entry),
      this.readyTimeoutMs,
    );
    const client = await this.ensureRuntimeReady(runtime, waitMs, options.signal);
    try {
      return await client.callTool(tool, args, options);
    } catch (error) {
      if (isAuthRequiredError(error)) {
        this.markAuthRequired(runtime, error);
      }
      throw error;
    }
  }

  private closeRuntime(runtime: ServerRuntime): Promise<void> {
    if (runtime.closePromise !== undefined) return runtime.closePromise;
    const closing = (async () => {
      runtime.status = "closed";
      const clients = new Set<McpClient>();
      if (runtime.client !== undefined) clients.add(runtime.client);
      if (runtime.pendingClient !== undefined) clients.add(runtime.pendingClient);
      runtime.client = undefined;
      const connecting = runtime.connecting;
      const authProvider = runtime.activeAuthProvider;
      await Promise.all([
        ...[...clients].map((client) => client.close().catch(() => undefined)),
        ...(connecting === undefined ? [] : [connecting.catch(() => undefined)]),
        ...(hasSettledMethod(authProvider) ? [authProvider.settled().catch(() => undefined)] : []),
      ]);
      this.log.flushStderr(runtime.entry.name);
    })();
    runtime.closePromise = closing;
    return closing;
  }
}

export function createMcpHub(options: McpHubOptions = {}): McpHub {
  return new McpHub(options);
}

export type McpExtension = Extension & {
  readonly hub: McpHub;
};

export function createMcpExtension(source: McpHub | McpHubOptions = {}): McpExtension {
  const hub = source instanceof McpHub ? source : createMcpHub(source);
  return Object.assign(hub.extension(), { hub });
}
