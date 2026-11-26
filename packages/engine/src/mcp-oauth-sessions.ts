import {
  type McpOAuthConfig,
  type McpOAuthCredentialStore,
  type McpOAuthSession,
  type McpOAuthSignInEvent,
  type OAuthChallenge,
  startMcpOAuthSignIn,
} from "@eevee/agent";
import type { McpOAuthEvent, StartMcpOAuthResponse } from "@eevee/protocol";
import { EngineError } from "./engine-error.ts";

export type StartMcpOAuthSessionOptions = {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly store: McpOAuthCredentialStore;
  readonly settings?: McpOAuthConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly challenge?: OAuthChallenge;
  readonly beforeStart?: () => void;
  readonly onComplete?: (serverName: string) => Promise<void>;
};

type ManagedOAuthSession = {
  readonly sessionId: string;
  readonly serverName: string;
  readonly raw: McpOAuthSession;
  readonly history: McpOAuthEvent[];
  readonly subscribers: Set<(event: McpOAuthEvent) => void>;
  terminal: boolean;
  done: Promise<void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

const SESSION_RETENTION_MS = 60_000;

function toProtocolEvent(event: McpOAuthSignInEvent): McpOAuthEvent {
  switch (event.type) {
    case "auth_url":
      return {
        type: "auth_url",
        url: event.url,
        redirectUrl: event.redirectUrl,
        ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
      };
    case "progress":
      return { type: "progress", message: event.message };
    case "complete":
      return { type: "complete" };
    case "error":
      return { type: "error", code: event.code, message: event.message };
  }
}

export class McpOAuthSessionManager {
  readonly #sessions = new Map<string, ManagedOAuthSession>();
  readonly #startChains = new Map<string, Promise<void>>();
  #closed = false;

  start(options: StartMcpOAuthSessionOptions): Promise<StartMcpOAuthResponse> {
    if (this.#closed) {
      return Promise.reject(new EngineError(503, "engine_closed", "Engine is closing"));
    }
    return this.#enqueueStart(options.serverName, () => this.#startNow(options));
  }

  #enqueueStart<T>(serverName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#startChains.get(serverName) ?? Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    const cleaned = tail.finally(() => {
      if (this.#startChains.get(serverName) === cleaned) {
        this.#startChains.delete(serverName);
      }
    });
    this.#startChains.set(serverName, cleaned);
    return cleaned.then(() => run);
  }

  async #startNow(options: StartMcpOAuthSessionOptions): Promise<StartMcpOAuthResponse> {
    if (this.#closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }

    await this.cancelForServer(options.serverName);
    if (this.#closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }
    options.beforeStart?.();

    const history: McpOAuthEvent[] = [];
    const subscribers = new Set<(event: McpOAuthEvent) => void>();
    let completed = false;
    let terminalError: McpOAuthEvent | undefined;
    let managedRef: ManagedOAuthSession | undefined;

    const emit = (event: McpOAuthEvent): void => {
      history.push(event);
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(event);
        } catch {
          // Isolate stream subscriber failures.
        }
      }
    };

    const raw = startMcpOAuthSignIn({
      name: options.serverName,
      serverUrl: options.serverUrl,
      store: options.store,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.challenge === undefined ? {} : { challenge: options.challenge }),
      onEvent: (event) => {
        if (event.type === "complete") {
          completed = true;
          return;
        }
        if (event.type === "error") {
          terminalError = toProtocolEvent(event);
          return;
        }
        emit(toProtocolEvent(event));
      },
    });

    const sessionId = raw.id;
    const managed: ManagedOAuthSession = {
      sessionId,
      serverName: options.serverName,
      raw,
      history,
      subscribers,
      terminal: false,
      done: Promise.resolve(),
    };
    managedRef = managed;
    this.#sessions.set(sessionId, managed);

    const scheduleCleanup = (): void => {
      if (this.#closed) return;
      managed.cleanupTimer = setTimeout(() => {
        this.#sessions.delete(sessionId);
      }, SESSION_RETENTION_MS);
      managed.cleanupTimer.unref?.();
    };

    managed.done = (async () => {
      try {
        await raw.done;
        if (completed && !this.#closed) {
          await options.onComplete?.(options.serverName).catch(() => undefined);
        }
      } finally {
        if (managedRef !== undefined) {
          managedRef.terminal = true;
        }
        if (completed) {
          emit({ type: "complete" });
        } else if (terminalError !== undefined) {
          emit(terminalError);
        } else {
          emit({
            type: "error",
            code: "login_failed",
            message: "MCP OAuth sign-in ended unexpectedly",
          });
        }
        subscribers.clear();
        scheduleCleanup();
      }
    })();

    return { sessionId, server: options.serverName };
  }

  subscribe(
    serverName: string,
    sessionId: string,
    onEvent: (event: McpOAuthEvent) => void,
  ): () => void {
    const session = this.#requireSession(serverName, sessionId);
    for (const event of session.history) {
      onEvent(event);
    }
    if (session.terminal) {
      return () => {};
    }
    session.subscribers.add(onEvent);
    return () => {
      session.subscribers.delete(onEvent);
    };
  }

  submitInput(serverName: string, sessionId: string, redirectUrl: string): void {
    const session = this.#requireSession(serverName, sessionId);
    if (session.terminal) {
      throw new EngineError(
        409,
        "mcp_oauth_session_closed",
        `MCP OAuth session ${sessionId} has ended`,
      );
    }
    try {
      session.raw.submitRedirectUrl(redirectUrl);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("has ended")) {
        throw new EngineError(409, "mcp_oauth_session_closed", msg);
      }
      if (msg.includes("not waiting")) {
        throw new EngineError(409, "mcp_oauth_not_waiting", msg);
      }
      throw new EngineError(400, "invalid_request", msg);
    }
  }

  cancel(serverName: string, sessionId: string): void {
    const session = this.#requireSession(serverName, sessionId);
    if (session.terminal) return;
    session.raw.cancel();
  }

  async cancelForServer(serverName: string): Promise<void> {
    await this.cancelAllForServers([serverName]);
  }

  async cancelAllForServers(serverNames: Iterable<string>): Promise<void> {
    const targets = new Set(serverNames);
    if (targets.size === 0) return;
    const pending: Promise<void>[] = [];
    for (const session of this.#sessions.values()) {
      if (targets.has(session.serverName) && !session.terminal) {
        session.raw.cancel();
        pending.push(session.done);
      }
    }
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const session of this.#sessions.values()) {
      if (!session.terminal) {
        session.raw.cancel();
      }
    }
    while (this.#startChains.size > 0) {
      await Promise.allSettled([...this.#startChains.values()]);
    }
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) {
      if (session.cleanupTimer !== undefined) {
        clearTimeout(session.cleanupTimer);
        session.cleanupTimer = undefined;
      }
      if (!session.terminal) {
        session.raw.cancel();
      }
    }
    await Promise.allSettled(sessions.map((session) => session.done));
    this.#sessions.clear();
  }

  #requireSession(serverName: string, sessionId: string): ManagedOAuthSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.serverName !== serverName) {
      throw new EngineError(
        404,
        "mcp_oauth_session_not_found",
        `Unknown MCP OAuth session ${sessionId}`,
      );
    }
    return session;
  }
}
