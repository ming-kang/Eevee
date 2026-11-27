import { setTimeout as delay } from "node:timers/promises";
import {
  type AuthProvider,
  type CallToolResult,
  McpClient,
  type McpRequestOptions,
  type Tool as McpTool,
  type McpTransport,
} from "@earendil-works/pi-mcp";
import {
  McpOAuthAuthorizationRequiredError,
  type OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";
import { errorMessage } from "../../shared/guards.ts";
import { getMcpToolExposure, type McpServerEntry } from "./config.ts";
import type { McpServerLog } from "./log.ts";
import { createEeveeMcpAuthProvider, type McpOAuthCredentialStore } from "./oauth.ts";
import {
  buildOfflineMcpSnapshot,
  type McpServerSnapshot,
  type McpServerStatus,
} from "./snapshot.ts";
import {
  createDefaultTransport,
  hasSettledMethod,
  isAuthRequiredError,
  isTransientError,
  raceTimeout,
  toMcpRoots,
} from "./transport.ts";

type ConnectionState =
  | { readonly kind: "idle"; readonly tools: readonly McpTool[]; readonly instructions?: string }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "connecting";
      readonly promise: Promise<McpClient>;
      readonly tools: readonly McpTool[];
      readonly instructions?: string;
      readonly abortRetry: AbortController;
      pendingClient?: McpClient;
      authProvider?: AuthProvider;
    }
  | {
      readonly kind: "connected" | "degraded";
      readonly client: McpClient;
      readonly tools: readonly McpTool[];
      readonly instructions?: string;
      readonly error?: string;
      readonly authProvider?: AuthProvider;
    }
  | {
      readonly kind: "auth_required" | "failed";
      readonly error: string;
      readonly tools: readonly McpTool[];
      readonly instructions?: string;
    }
  | {
      readonly kind: "disconnected";
      readonly error?: string;
      readonly tools: readonly McpTool[];
      readonly instructions?: string;
    }
  | {
      readonly kind: "closed";
      readonly closePromise: Promise<void>;
    };

export type McpServerConnectionOptions = {
  readonly entry: McpServerEntry;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly defaultTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly transientRetryDelayMs: number;
  readonly getRoots?: () => readonly string[] | undefined;
  readonly log: McpServerLog;
  readonly oauthStore?: McpOAuthCredentialStore;
  readonly onAuthChallenge?: (serverName: string, challenge: OAuthChallenge) => void;
  readonly authProvider?: AuthProvider | ((entry: McpServerEntry) => AuthProvider | undefined);
  readonly createTransport?: (
    entry: McpServerEntry,
    cwd: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => McpTransport;
  readonly onStateChange: () => void;
};

function initialState(entry: McpServerEntry): ConnectionState {
  return entry.config.enabled !== false ? { kind: "idle", tools: [] } : { kind: "disabled" };
}

function collectClients(state: ConnectionState): McpClient[] {
  if (state.kind === "connected" || state.kind === "degraded") return [state.client];
  if (state.kind === "connecting" && state.pendingClient !== undefined) {
    return [state.pendingClient];
  }
  return [];
}

function isLiveState(
  state: ConnectionState,
): state is Extract<ConnectionState, { readonly kind: "connected" | "degraded" }> {
  return state.kind === "connected" || state.kind === "degraded";
}

export class McpServerConnection {
  private entry: McpServerEntry;
  private state: ConnectionState;
  private epoch = 0;
  private lastChallenge?: OAuthChallenge;
  private activeReconnect?: Promise<void>;
  private readonly options: McpServerConnectionOptions;

  constructor(options: McpServerConnectionOptions) {
    this.options = options;
    this.entry = options.entry;
    this.state = initialState(options.entry);
  }

  get name(): string {
    return this.entry.name;
  }

  get configEntry(): McpServerEntry {
    return this.entry;
  }

  get status(): McpServerStatus {
    return this.state.kind;
  }

  get enabled(): boolean {
    return this.entry.config.enabled !== false;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get hasResources(): boolean {
    return isLiveState(this.state) && Boolean(this.state.client.serverCapabilities?.resources);
  }

  get tools(): readonly McpTool[] {
    return "tools" in this.state ? this.state.tools : [];
  }

  get instructions(): string | undefined {
    return "instructions" in this.state ? this.state.instructions : undefined;
  }

  get error(): string | undefined {
    return "error" in this.state ? this.state.error : undefined;
  }

  get authChallenge(): OAuthChallenge | undefined {
    return this.lastChallenge;
  }

  updateEntry(entry: McpServerEntry): void {
    this.entry = entry;
  }

  timeoutMs(): number {
    return this.entry.config.timeout !== undefined
      ? this.entry.config.timeout * 1000
      : this.options.defaultTimeoutMs;
  }

  snapshot(recentLogs: readonly string[] = []): McpServerSnapshot {
    const base = buildOfflineMcpSnapshot(this.entry);
    const { tools, instructions, error } = this;
    const status = this.state.kind;
    return {
      ...base,
      status,
      ...(instructions === undefined ? {} : { instructions }),
      toolCount: tools.length,
      ...(error === undefined ? {} : { error }),
      hasResources: this.hasResources,
      ...(status === "auth_required" ? { authRequired: true } : {}),
      ...(tools.length > 0 || status === "connected" || status === "degraded"
        ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              exposure: getMcpToolExposure(this.entry.config, tool.name),
            })),
          }
        : {}),
      ...(recentLogs.length > 0 ? { recentLogs } : {}),
    };
  }

  async notifyRootsChanged(): Promise<void> {
    if (isLiveState(this.state) && this.state.client.connectionState === "connected") {
      await this.state.client.notify("notifications/roots/list_changed");
    }
  }

  connect(force: boolean): Promise<McpClient> {
    if (this.state.kind === "closed") {
      return Promise.reject(new Error(`MCP server "${this.entry.name}" is closed`));
    }
    if (this.state.kind === "disabled") {
      return Promise.reject(new Error(`MCP server "${this.entry.name}" is disabled`));
    }
    if (isLiveState(this.state)) {
      if (this.state.client.connectionState === "connected") {
        return Promise.resolve(this.state.client);
      }
      void this.state.client.close().catch(() => undefined);
    }
    if (this.state.kind === "connecting") return this.state.promise;
    if (this.state.kind === "auth_required" && !force) {
      return Promise.reject(new McpOAuthAuthorizationRequiredError());
    }
    if (this.state.kind === "failed" && !force) {
      return Promise.reject(
        new Error(`MCP server "${this.entry.name}" failed: ${this.state.error}`),
      );
    }
    return this.beginConnecting({ tools: this.tools, instructions: this.instructions });
  }

  reconnect(): Promise<void> {
    if (this.state.kind === "closed" || !this.enabled) return Promise.resolve();
    if (this.activeReconnect !== undefined) return this.activeReconnect;
    const prev = this.state;
    if (prev.kind === "connecting") prev.abortRetry.abort();

    const connectPromise = this.beginConnecting({
      tools: [],
      beforeOpen: () => this.teardownResources(prev),
    });
    const run = connectPromise.then(
      () => undefined,
      () => undefined,
    );
    const tracked = run.finally(() => {
      if (this.activeReconnect === tracked) this.activeReconnect = undefined;
    });
    this.activeReconnect = tracked;
    return tracked;
  }

  ensureReady(timeoutMs: number, signal?: AbortSignal): Promise<McpClient> {
    if (!this.enabled) {
      return Promise.reject(new Error(`MCP server "${this.entry.name}" is disabled`));
    }
    if (this.state.kind === "closed") {
      return Promise.reject(new Error(`MCP server "${this.entry.name}" is closed`));
    }
    if (isLiveState(this.state) && this.state.client.connectionState === "connected") {
      return Promise.resolve(this.state.client);
    }
    const connectPromise = this.connect(false);
    // Keep background connect rejections handled if ready timeout fires first.
    connectPromise.catch(() => undefined);
    return raceTimeout(
      connectPromise,
      timeoutMs,
      `Timed out waiting ${timeoutMs}ms for MCP server "${this.entry.name}" to become ready`,
      signal,
    );
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    options: McpRequestOptions,
  ): Promise<CallToolResult> {
    const waitMs = Math.min(options.timeoutMs ?? this.timeoutMs(), this.options.readyTimeoutMs);
    const client = await this.ensureReady(waitMs, options.signal);
    try {
      return await client.callTool(tool, args, options);
    } catch (error) {
      if (isAuthRequiredError(error)) this.markAuthRequired(client, error);
      throw error;
    }
  }

  async runResourceRead<T>(
    options: McpRequestOptions,
    fn: (client: McpClient, reqOptions: McpRequestOptions) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs();
    const waitMs = Math.min(timeoutMs, this.options.readyTimeoutMs);
    const client = await this.ensureReady(waitMs, options.signal);
    if (!client.serverCapabilities?.resources) {
      throw new Error(`MCP server "${this.entry.name}" does not advertise resources capability`);
    }
    const reqOptions: McpRequestOptions = { ...options, timeoutMs };
    try {
      return await fn(client, reqOptions);
    } catch (error) {
      if (isAuthRequiredError(error)) {
        this.markAuthRequired(client, error);
        throw error;
      }
      if (!isTransientError(error) || options.signal?.aborted || this.state.kind === "closed") {
        throw error;
      }
      this.options.log.recordDiagnostic(
        this.entry.name,
        "warn",
        `Transient resource request error, retrying once: ${errorMessage(error)}`,
      );
      if (this.options.transientRetryDelayMs > 0) {
        await delay(this.options.transientRetryDelayMs, undefined, { signal: options.signal });
      }
      const nextClient = await this.ensureReady(waitMs, options.signal);
      try {
        return await fn(nextClient, reqOptions);
      } catch (retryError) {
        if (isAuthRequiredError(retryError)) this.markAuthRequired(nextClient, retryError);
        throw retryError;
      }
    }
  }

  close(): Promise<void> {
    if (this.state.kind === "closed") return this.state.closePromise;
    const prev = this.state;
    this.epoch += 1;
    const prevReconnect = this.activeReconnect;
    if (prev.kind === "connecting") prev.abortRetry.abort();
    const closePromise = this.teardownResources(prev, prevReconnect);
    this.state = { kind: "closed", closePromise };
    return closePromise;
  }

  private async teardownResources(prev: ConnectionState, extra?: Promise<void>): Promise<void> {
    const clients = collectClients(prev);
    const authProvider = "authProvider" in prev ? prev.authProvider : undefined;
    const prevConnecting = prev.kind === "connecting" ? prev.promise : undefined;
    await Promise.all([
      ...clients.map((client) => client.close().catch(() => undefined)),
      ...(prevConnecting === undefined ? [] : [prevConnecting.catch(() => undefined)]),
      ...(extra === undefined ? [] : [extra.catch(() => undefined)]),
      ...(hasSettledMethod(authProvider) ? [authProvider.settled().catch(() => undefined)] : []),
    ]);
    this.options.log.flushStderr(this.entry.name);
  }

  private beginConnecting(config: {
    readonly tools: readonly McpTool[];
    readonly instructions?: string;
    readonly beforeOpen?: () => Promise<void>;
  }): Promise<McpClient> {
    const epoch = ++this.epoch;
    const abortRetry = new AbortController();
    let resolvePromise!: (client: McpClient) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<McpClient>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Prevent unhandled rejection when callers time out or reconnect swallows failures.
    promise.catch(() => undefined);

    this.state = {
      kind: "connecting",
      promise,
      tools: config.tools,
      ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
      abortRetry,
    };
    this.options.onStateChange();

    void (async () => {
      try {
        if (config.beforeOpen !== undefined) {
          await config.beforeOpen();
          if (this.epoch !== epoch) throw new Error(`MCP server "${this.entry.name}" is closed`);
        }
        resolvePromise(await this.openWithRetry(epoch, abortRetry.signal));
      } catch (error) {
        if (this.epoch === epoch) {
          const message = errorMessage(error);
          this.state = {
            kind: isAuthRequiredError(error) ? "auth_required" : "failed",
            error: message,
            tools: config.tools,
            ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
          };
          this.options.log.recordDiagnostic(this.entry.name, "error", message);
          this.options.onStateChange();
        }
        rejectPromise(error);
      }
    })();

    return promise;
  }

  private async openWithRetry(epoch: number, retrySignal: AbortSignal): Promise<McpClient> {
    const isHttp = "url" in this.entry.config;
    try {
      return await this.openOnce(epoch);
    } catch (error) {
      if (!isHttp || !isTransientError(error) || this.epoch !== epoch) throw error;
      this.options.log.recordDiagnostic(
        this.entry.name,
        "warn",
        `Transient HTTP connection error, retrying once: ${errorMessage(error)}`,
      );
      if (this.options.transientRetryDelayMs > 0) {
        await delay(this.options.transientRetryDelayMs, undefined, { signal: retrySignal }).catch(
          () => undefined,
        );
      }
      if (this.epoch !== epoch) throw new Error(`MCP server "${this.entry.name}" is closed`);
      return this.openOnce(epoch);
    }
  }

  private async openOnce(epoch: number): Promise<McpClient> {
    if (this.epoch !== epoch) throw new Error(`MCP server "${this.entry.name}" is closed`);
    const entry = this.entry;
    const timeoutMs = this.timeoutMs();
    const hasRoots = this.options.getRoots?.() !== undefined;
    const client = new McpClient({
      ...this.options.clientInfo,
      requestTimeoutMs: timeoutMs,
      ...(hasRoots
        ? {
            capabilities: { roots: { listChanged: true } },
            roots: () => toMcpRoots(this.options.getRoots?.() ?? [], this.options.cwd),
          }
        : {}),
    });

    if (this.state.kind === "connecting") this.state.pendingClient = client;

    try {
      const authProvider = this.createAuthProvider(epoch);
      if (this.state.kind === "connecting" && this.epoch === epoch) {
        this.state.authProvider = authProvider;
      }
      client.onNotification("notifications/tools/list_changed", () => {
        void this.refreshTools(epoch, client);
      });
      client.onNotification("notifications/resources/list_changed", () => {
        if (this.epoch === epoch && isLiveState(this.state) && this.state.client === client) {
          this.options.onStateChange();
        }
      });
      client.onNotification("notifications/message", (params) => {
        this.options.log.recordNotification(entry.name, params);
      });
      client.onError((error) => {
        this.options.log.recordDiagnostic(entry.name, "error", errorMessage(error));
      });
      client.onClose(() => this.handleClientClose(epoch, client));

      const transport = this.options.createTransport
        ? this.options.createTransport(entry, this.options.cwd, this.options.env)
        : createDefaultTransport(
            entry,
            this.options.cwd,
            this.options.env,
            authProvider,
            (chunk) => {
              this.options.log.recordStderr(entry.name, chunk);
            },
          );

      await client.connect(transport);
      if (this.epoch !== epoch) throw new Error(`MCP server "${entry.name}" is closed`);
      const tools = client.serverCapabilities?.tools ? await client.listTools({ timeoutMs }) : [];
      if (this.epoch !== epoch) throw new Error(`MCP server "${entry.name}" is closed`);
      if (client.connectionState !== "connected") {
        throw new Error(`MCP server "${entry.name}" closed while connecting`);
      }

      const instructions = client.instructions?.trim() || undefined;
      this.state = {
        kind: "connected",
        client,
        tools,
        ...(instructions === undefined ? {} : { instructions }),
        ...(authProvider === undefined ? {} : { authProvider }),
      };
      this.options.onStateChange();
      return client;
    } catch (error) {
      this.options.log.flushStderr(entry.name);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private createAuthProvider(epoch: number): AuthProvider | undefined {
    const entry = this.entry;
    if (this.options.authProvider !== undefined) {
      return typeof this.options.authProvider === "function"
        ? this.options.authProvider(entry)
        : this.options.authProvider;
    }
    if (this.options.oauthStore !== undefined && "url" in entry.config) {
      return createEeveeMcpAuthProvider({
        name: entry.name,
        serverUrl: entry.config.url,
        store: this.options.oauthStore,
        settings: () => ("url" in this.entry.config ? this.entry.config.oauth : undefined),
        env: this.options.env,
        onChallenge: (challenge) => {
          if (this.epoch === epoch) {
            this.lastChallenge = challenge;
            this.options.onAuthChallenge?.(entry.name, challenge);
          }
        },
      });
    }
    return undefined;
  }

  private async refreshTools(epoch: number, client: McpClient): Promise<void> {
    if (this.epoch !== epoch || !isLiveState(this.state) || this.state.client !== client) return;
    try {
      const tools = await client.listTools({ timeoutMs: this.timeoutMs() });
      if (this.epoch !== epoch || !isLiveState(this.state) || this.state.client !== client) return;
      this.state = {
        kind: "connected",
        client,
        tools,
        ...(this.state.instructions === undefined ? {} : { instructions: this.state.instructions }),
        ...(this.state.authProvider === undefined ? {} : { authProvider: this.state.authProvider }),
      };
      this.options.onStateChange();
    } catch (error) {
      if (this.epoch !== epoch || !isLiveState(this.state) || this.state.client !== client) return;
      if (isAuthRequiredError(error)) {
        this.markAuthRequired(client, error);
        return;
      }
      const message = `Failed to refresh tools: ${errorMessage(error)}`;
      this.state = {
        kind: "degraded",
        client,
        tools: this.state.tools,
        error: message,
        ...(this.state.instructions === undefined ? {} : { instructions: this.state.instructions }),
        ...(this.state.authProvider === undefined ? {} : { authProvider: this.state.authProvider }),
      };
      this.options.log.recordDiagnostic(this.entry.name, "warn", message);
      this.options.onStateChange();
    }
  }

  private handleClientClose(epoch: number, client: McpClient): void {
    this.options.log.flushStderr(this.entry.name);
    if (this.epoch !== epoch || !isLiveState(this.state) || this.state.client !== client) return;
    this.state = {
      kind: "disconnected",
      error: "Connection closed",
      tools: this.state.tools,
      ...(this.state.instructions === undefined ? {} : { instructions: this.state.instructions }),
    };
    this.options.onStateChange();
  }

  private markAuthRequired(client: McpClient, error: unknown): void {
    if (!isLiveState(this.state) || this.state.client !== client) return;
    this.epoch += 1;
    const { tools, instructions } = this.state;
    this.state = {
      kind: "auth_required",
      error: errorMessage(error),
      tools,
      ...(instructions === undefined ? {} : { instructions }),
    };
    void client.close().catch(() => undefined);
    this.options.onStateChange();
  }
}
