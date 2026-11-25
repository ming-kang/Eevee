import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineExtension, type Extension, type Registry } from "@earendil-works/pi-durable";
import {
  type AuthProvider,
  type CallToolResult,
  McpClient,
  type McpOutputSaver,
  type McpRequestOptions,
  type Tool as McpTool,
  type McpTransport,
  mcpNamespace,
  mcpServerSummary,
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { type McpServerEntry, resolveServerEnv, resolveServerHeaders } from "./config.ts";
import { adaptMcpTools } from "./tools.ts";

export const MCP_EXTENSION = "eevee.mcp";
export const MCP_SERVER_EXTENSION_PREFIX = "eevee.mcp.";

export function mcpServerExtensionName(server: string): string {
  return `${MCP_SERVER_EXTENSION_PREFIX}${server}`;
}

export type McpServerStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type McpServerSnapshot = {
  readonly name: string;
  readonly status: McpServerStatus;
  readonly enabled: boolean;
  readonly description?: string;
  readonly instructions?: string;
  readonly toolCount: number;
  readonly error?: string;
};

export type McpHubOptions = {
  readonly servers?: readonly McpServerEntry[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  readonly defaultTimeoutMs?: number;
  readonly authProvider?: AuthProvider | ((entry: McpServerEntry) => AuthProvider | undefined);
  readonly createTransport?: (
    entry: McpServerEntry,
    cwd: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => McpTransport;
  readonly saveOutput?: McpOutputSaver;
};

type ServerRuntime = {
  entry: McpServerEntry;
  status: McpServerStatus;
  error?: string;
  instructions?: string;
  tools: McpTool[];
  client?: McpClient;
  pendingClient?: McpClient;
  connecting?: Promise<McpClient>;
  closePromise?: Promise<void>;
  reconnecting?: Promise<void>;
};

type RegistryBinding = {
  readonly registry: Registry;
  installed: Set<string>;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CLIENT_INFO = { name: "eevee", version: "0.0.1" } as const;

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
  return { entry, status: "idle", tools: [] };
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

function createDefaultTransport(
  entry: McpServerEntry,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  authProvider: AuthProvider | undefined,
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
    entry.config.exposure ?? "deferred",
    ...Object.values(entry.config.toolExposure ?? {}),
  ]);
}

function exposureText(entry: McpServerEntry): string {
  const exposures = configuredExposures(entry);
  return ["direct", "deferred", "codemode", "hidden"]
    .filter((exposure) => exposures.has(exposure))
    .join("+");
}

export class McpHub {
  private servers = new Map<string, ServerRuntime>();
  private readonly cwd: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly clientInfo: { readonly name: string; readonly version: string };
  private readonly defaultTimeoutMs: number;
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
    this.authProvider = options.authProvider;
    this.createTransport = options.createTransport;
    this.saveOutput = options.saveOutput ?? createDefaultOutputSaver();
    for (const entry of validateEntries(options.servers ?? [])) {
      this.servers.set(entry.name, createRuntime(entry));
    }
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("MCP hub is closed");
    const starts = [...this.servers.values()]
      .filter((runtime) => isEnabled(runtime.entry))
      .map((runtime) => this.connectRuntime(runtime, true).then(() => undefined));
    await Promise.allSettled(starts);
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
        if (existing !== undefined) closing.push(this.closeRuntime(existing));
        next.set(entry.name, createRuntime(entry));
      }
    }
    for (const [name, runtime] of previous) {
      if (!retained.has(name) && !next.has(name)) closing.push(this.closeRuntime(runtime));
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
    if (runtime.reconnecting !== undefined) return runtime.reconnecting;
    const run = (async () => {
      await this.closeRuntime(runtime);
      if (this.closed || this.servers.get(runtime.entry.name) !== runtime) return;
      runtime.closePromise = undefined;
      runtime.status = "idle";
      runtime.tools = [];
      runtime.instructions = undefined;
      runtime.error = undefined;
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
    return [...this.servers.values()].map((runtime) => ({
      name: runtime.entry.name,
      status: runtime.status,
      enabled: isEnabled(runtime.entry),
      ...(runtime.entry.config.description === undefined
        ? {}
        : { description: runtime.entry.config.description }),
      ...(runtime.instructions === undefined ? {} : { instructions: runtime.instructions }),
      toolCount: runtime.tools.length,
      ...(runtime.error === undefined ? {} : { error: runtime.error }),
    }));
  }

  extension(): Extension {
    return defineExtension({
      name: MCP_EXTENSION,
      sections: [
        {
          key: "mcp_servers",
          render: () => this.renderServersSection(),
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
        return defineExtension({
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
    this.closePromise = (async () => {
      await Promise.all([...this.servers.values()].map((runtime) => this.closeRuntime(runtime)));
      this.notify();
      this.listeners.clear();
    })();
    return this.closePromise;
  }

  private authProviderOf(entry: McpServerEntry): AuthProvider | undefined {
    return typeof this.authProvider === "function" ? this.authProvider(entry) : this.authProvider;
  }

  private timeoutMsOf(entry: McpServerEntry): number {
    return entry.config.timeout !== undefined ? entry.config.timeout * 1000 : this.defaultTimeoutMs;
  }

  private renderServersSection(): string | undefined {
    const servers = [...this.servers.values()].filter((runtime) => isEnabled(runtime.entry));
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
      const state =
        runtime.status === "connected"
          ? `connected, ${runtime.tools.length} tool${runtime.tools.length === 1 ? "" : "s"}`
          : runtime.status === "failed"
            ? `failed${runtime.error === undefined ? "" : `: ${firstLine(runtime.error)}`}`
            : runtime.status;
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

  private connectRuntime(runtime: ServerRuntime, force: boolean): Promise<McpClient> {
    if (this.closed || runtime.status === "closed") {
      return Promise.reject(new Error(`MCP server "${runtime.entry.name}" is closed`));
    }
    if (runtime.client?.connectionState === "connected" && runtime.status === "connected") {
      return Promise.resolve(runtime.client);
    }
    if (runtime.client !== undefined && runtime.client.connectionState !== "connected") {
      runtime.client = undefined;
      if (runtime.status === "connected") runtime.status = "disconnected";
    }
    if (runtime.connecting !== undefined) return runtime.connecting;
    if (runtime.status === "failed" && !force) {
      return Promise.reject(
        new Error(`MCP server "${runtime.entry.name}" failed: ${runtime.error ?? "unknown error"}`),
      );
    }

    runtime.status = "connecting";
    runtime.error = undefined;
    this.notify();
    const connecting = (async (): Promise<McpClient> => {
      try {
        return await this.openRuntime(runtime);
      } catch (error) {
        if (runtime.status !== "closed" && !this.closed) {
          runtime.status = "failed";
          runtime.error = errorMessage(error);
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

  private async openRuntime(runtime: ServerRuntime): Promise<McpClient> {
    const entry = runtime.entry;
    const timeoutMs = this.timeoutMsOf(entry);
    const client = new McpClient({
      ...this.clientInfo,
      requestTimeoutMs: timeoutMs,
    });
    runtime.pendingClient = client;
    try {
      client.onNotification("notifications/tools/list_changed", () => {
        void this.refreshTools(runtime, client);
      });
      client.onClose(() => this.handleClientClose(runtime, client));
      const transport = this.createTransport
        ? this.createTransport(entry, this.cwd, this.env)
        : createDefaultTransport(entry, this.cwd, this.env, this.authProviderOf(entry));
      await client.connect(transport);
      const tools = client.serverCapabilities?.tools ? await client.listTools({ timeoutMs }) : [];
      if (runtime.status === "closed" || this.closed) {
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
      this.notify();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      if (runtime.pendingClient === client) runtime.pendingClient = undefined;
    }
  }

  private async refreshTools(runtime: ServerRuntime, client: McpClient): Promise<void> {
    let changed = false;
    try {
      const tools = await client.listTools({ timeoutMs: this.timeoutMsOf(runtime.entry) });
      if (runtime.client !== client || runtime.status !== "connected") return;
      runtime.tools = tools;
      runtime.error = undefined;
      changed = true;
    } catch (error) {
      if (runtime.client !== client || runtime.status !== "connected") return;
      runtime.error = `Failed to refresh tools: ${errorMessage(error)}`;
      changed = true;
    } finally {
      if (changed) this.notify();
    }
  }

  private handleClientClose(runtime: ServerRuntime, client: McpClient): void {
    if (this.closed || runtime.status === "closed" || runtime.client !== client) return;
    runtime.client = undefined;
    if (runtime.status !== "connected") return;
    runtime.status = "disconnected";
    runtime.error = "Connection closed";
    this.notify();
  }

  private async clientForTool(runtime: ServerRuntime): Promise<McpClient> {
    if (!isEnabled(runtime.entry))
      throw new Error(`MCP server "${runtime.entry.name}" is disabled`);
    if (runtime.status === "closed" || this.closed) {
      throw new Error(`MCP server "${runtime.entry.name}" is closed`);
    }
    return this.connectRuntime(runtime, false);
  }

  private async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: McpRequestOptions,
  ): Promise<CallToolResult> {
    const runtime = this.servers.get(server);
    if (runtime === undefined) throw new Error(`Unknown MCP server "${server}"`);
    const client = await this.clientForTool(runtime);
    return client.callTool(tool, args, options);
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
      await Promise.all([
        ...[...clients].map((client) => client.close().catch(() => undefined)),
        ...(connecting === undefined ? [] : [connecting.catch(() => undefined)]),
      ]);
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
