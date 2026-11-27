import type { Extension, Registry } from "@earendil-works/pi-durable";
import {
  type AuthProvider,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type McpOutputSaver,
  type McpRequestOptions,
  type McpTransport,
  mcpNamespace,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
} from "@earendil-works/pi-mcp";
import type { OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import {
  type McpServerEntry,
  type ResolvedMcpServerRoles,
  resolveMcpServerRoles,
} from "./config.ts";
import { McpServerConnection } from "./connection.ts";
import {
  createMcpHubExtension,
  createMcpServerExtensionEntry,
  McpRegistryBindings,
  type McpServerExtensionEntry,
  mcpServerExtensionName,
} from "./extension.ts";
import { McpServerLog } from "./log.ts";
import type { McpOAuthCredentialStore } from "./oauth.ts";
import type { McpResourceHost, McpResourceServerInfo } from "./resources.ts";
import type { McpServerSnapshot } from "./snapshot.ts";
import {
  createDefaultOutputSaver,
  DEFAULT_CLIENT_INFO,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSIENT_RETRY_DELAY_MS,
  sameConfig,
} from "./transport.ts";

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

export class McpHub implements McpResourceHost {
  private connections = new Map<string, McpServerConnection>();
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
  private readonly registryBindings = new McpRegistryBindings();
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
      this.connections.set(entry.name, this.createConnection(entry));
    }
  }

  async start(options: McpHubStartOptions = {}): Promise<void> {
    if (this.closed) throw new Error("MCP hub is closed");
    const starts = [...this.connections.values()]
      .filter((conn) => conn.enabled)
      .map((conn) => conn.connect(true).catch(() => undefined));
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
    const conn = this.requireConnection(name);
    await conn.ensureReady(timeoutMs, signal);
  }

  async updateRoots(roots: readonly string[]): Promise<void> {
    this.rootsSource = [...roots];
    if (this.closed) return;
    await Promise.allSettled(
      [...this.connections.values()].map((conn) => conn.notifyRootsChanged()),
    );
  }

  getServerLogs(name: string): readonly string[] {
    return this.log.getServerLogs(name);
  }

  getAuthChallenge(name: string): OAuthChallenge | undefined {
    return this.connections.get(name)?.authChallenge;
  }

  async reload(servers: readonly McpServerEntry[]): Promise<void> {
    if (this.closed) throw new Error("MCP hub is closed");
    const entries = validateEntries(servers);
    const run = this.reloadChain.then(() => this.applyReload(entries));
    this.reloadChain = run.catch(() => undefined);
    await run;
  }

  async reconnect(serverName?: string): Promise<McpServerSnapshot[]> {
    if (this.closed) throw new Error("MCP hub is closed");
    if (serverName !== undefined) {
      const conn = this.requireConnection(serverName);
      if (!conn.enabled) throw new Error(`MCP server "${serverName}" is disabled`);
      await conn.reconnect();
      return this.status();
    }
    const enabled = [...this.connections.values()].filter((conn) => conn.enabled);
    await Promise.allSettled(enabled.map((conn) => conn.reconnect()));
    return this.status();
  }

  status(): McpServerSnapshot[] {
    return [...this.connections.values()].map((conn) =>
      conn.snapshot(this.log.getServerLogs(conn.name)),
    );
  }

  listResourceServers(): readonly McpResourceServerInfo[] {
    return [...this.connections.values()]
      .filter((conn) => conn.enabled)
      .map((conn) => ({
        name: conn.name,
        namespace: mcpNamespace(conn.name),
        extensionName: mcpServerExtensionName(conn.name),
        hasResources: conn.hasResources,
        status: conn.status,
      }));
  }

  async listResources(server: string, options: McpRequestOptions = {}): Promise<Resource[]> {
    return this.requireConnection(server).runResourceRead(options, (client, reqOptions) =>
      client.listResources(reqOptions),
    );
  }

  async listResourcesPage(
    server: string,
    cursor?: string,
    options: McpRequestOptions = {},
  ): Promise<ListResourcesResult> {
    return this.requireConnection(server).runResourceRead(options, (client, reqOptions) =>
      client.listResourcesPage(cursor, reqOptions),
    );
  }

  async listResourceTemplates(
    server: string,
    options: McpRequestOptions = {},
  ): Promise<ResourceTemplate[]> {
    return this.requireConnection(server).runResourceRead(options, (client, reqOptions) =>
      client.listResourceTemplates(reqOptions),
    );
  }

  async listResourceTemplatesPage(
    server: string,
    cursor?: string,
    options: McpRequestOptions = {},
  ): Promise<ListResourceTemplatesResult> {
    return this.requireConnection(server).runResourceRead(options, (client, reqOptions) =>
      client.listResourceTemplatesPage(cursor, reqOptions),
    );
  }

  async readResource(
    server: string,
    uri: string,
    options: McpRequestOptions = {},
  ): Promise<ReadResourceResult> {
    return this.requireConnection(server).runResourceRead(options, (client, reqOptions) =>
      client.readResource(uri, reqOptions),
    );
  }

  extension(): Extension {
    return createMcpHubExtension({
      getConnections: () => [...this.connections.values()],
      host: this,
      saveOutput: this.saveOutput,
      timeoutMs: this.defaultTimeoutMs,
    });
  }

  serverExtensionEntries(): McpServerExtensionEntry[] {
    return [...this.connections.values()]
      .filter((conn) => conn.enabled)
      .map((conn) =>
        createMcpServerExtensionEntry({
          connection: conn,
          saveOutput: this.saveOutput,
        }),
      );
  }

  rolesForExtension(extensionName: string): ResolvedMcpServerRoles | undefined {
    for (const conn of this.connections.values()) {
      if (conn.enabled && mcpServerExtensionName(conn.name) === extensionName) {
        return resolveMcpServerRoles(conn.configEntry.config);
      }
    }
    return undefined;
  }

  serverExtensions(): Extension[] {
    return this.serverExtensionEntries().map((entry) => entry.extension);
  }

  serverExtensionNames(): string[] {
    return [...this.connections.values()]
      .filter((conn) => conn.enabled)
      .map((conn) => mcpServerExtensionName(conn.name));
  }

  extensions(): Extension[] {
    return [this.extension(), ...this.serverExtensions()];
  }

  bindRegistry(registry: Registry): () => void {
    return this.registryBindings.bind(registry, () => this.extensions());
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
    const connections = [...this.connections.values()];
    this.closePromise = (async () => {
      await Promise.all(connections.map((conn) => conn.close()));
      await this.log.close();
      this.notify();
      this.listeners.clear();
    })();
    return this.closePromise;
  }

  private requireConnection(name: string): McpServerConnection {
    const conn = this.connections.get(name);
    if (conn === undefined) throw new Error(`Unknown MCP server "${name}"`);
    return conn;
  }

  private getConfiguredRoots(): readonly string[] | undefined {
    if (this.rootsSource === undefined) return undefined;
    return typeof this.rootsSource === "function" ? this.rootsSource() : this.rootsSource;
  }

  private createConnection(entry: McpServerEntry): McpServerConnection {
    return new McpServerConnection({
      entry,
      cwd: this.cwd,
      env: this.env,
      clientInfo: this.clientInfo,
      defaultTimeoutMs: this.defaultTimeoutMs,
      readyTimeoutMs: this.readyTimeoutMs,
      transientRetryDelayMs: this.transientRetryDelayMs,
      getRoots: () => this.getConfiguredRoots(),
      log: this.log,
      oauthStore: this.oauthStore,
      onAuthChallenge: this.onAuthChallenge,
      authProvider: this.authProvider,
      createTransport: this.createTransport,
      onStateChange: () => this.notify(),
    });
  }

  private async applyReload(entries: readonly McpServerEntry[]): Promise<void> {
    if (this.closed) throw new Error("MCP hub is closed");
    const previous = this.connections;
    const next = new Map<string, McpServerConnection>();
    const closing: Promise<void>[] = [];
    const retained = new Set<string>();

    for (const entry of entries) {
      const existing = previous.get(entry.name);
      if (existing !== undefined && sameConfig(existing.configEntry, entry)) {
        existing.updateEntry(entry);
        next.set(entry.name, existing);
        retained.add(entry.name);
      } else {
        if (existing !== undefined) {
          closing.push(existing.close());
        }
        next.set(entry.name, this.createConnection(entry));
      }
    }
    for (const [name, conn] of previous) {
      if (!retained.has(name) && !next.has(name)) {
        closing.push(conn.close());
      }
    }

    await Promise.all(closing);
    if (this.closed) throw new Error("MCP hub is closed");
    this.connections = next;
    this.notify();
    const starts = [...next.values()]
      .filter((conn) => conn.enabled)
      .map((conn) => conn.connect(true).catch(() => undefined));
    await Promise.allSettled(starts);
  }

  private notify(): void {
    this.registryBindings.publishAll(() => this.extensions());
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Listener failures must not turn a background server notification into an unhandled error.
      }
    }
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
