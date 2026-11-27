import {
  type McpOAuthConfig,
  type McpOAuthCredentialStore,
  type McpOAuthSession,
  McpOAuthSessionError,
  type McpOAuthSignInEvent,
  type OAuthChallenge,
  startMcpOAuthSignIn,
} from "@eevee/agent";
import type { McpOAuthEvent, StartMcpOAuthResponse } from "@eevee/protocol";
import { EngineError } from "./engine-error.ts";
import { KeyedSerialQueue } from "./serial-queue.ts";
import { BufferedSessionStream } from "./session-stream.ts";

export const GLOBAL_MCP_OAUTH_SCOPE = "global";

export function projectMcpOAuthScope(projectId: string): string {
  return `project:${projectId}`;
}

export type StartMcpOAuthSessionOptions = {
  readonly scopeKey?: string;
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
  readonly scopeKey: string;
  readonly serverName: string;
  readonly raw: McpOAuthSession;
  readonly stream: BufferedSessionStream<McpOAuthEvent>;
};

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
  readonly #startQueue = new KeyedSerialQueue();
  #closed = false;

  start(options: StartMcpOAuthSessionOptions): Promise<StartMcpOAuthResponse> {
    if (this.#closed) {
      return Promise.reject(new EngineError(503, "engine_closed", "Engine is closing"));
    }
    const scopeKey = options.scopeKey ?? GLOBAL_MCP_OAUTH_SCOPE;
    const chainKey = `${scopeKey}:${options.serverName}`;
    return this.#startQueue.enqueue(chainKey, () => this.#startNow(options, scopeKey));
  }

  async #startNow(
    options: StartMcpOAuthSessionOptions,
    scopeKey: string,
  ): Promise<StartMcpOAuthResponse> {
    if (this.#closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }

    await this.cancelForServer(options.serverName, scopeKey);
    if (this.#closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }
    options.beforeStart?.();

    let completed = false;
    let terminalError: McpOAuthEvent | undefined;
    let sessionId = "";
    const stream = new BufferedSessionStream<McpOAuthEvent>({
      onExpire: () => {
        if (!this.#closed && sessionId !== "") {
          this.#sessions.delete(sessionId);
        }
      },
    });

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
        stream.emit(toProtocolEvent(event));
      },
    });

    sessionId = raw.id;
    const managed: ManagedOAuthSession = {
      sessionId,
      scopeKey,
      serverName: options.serverName,
      raw,
      stream,
    };
    this.#sessions.set(sessionId, managed);

    stream.track(
      (async () => {
        try {
          await raw.done;
          if (completed && !this.#closed) {
            await options.onComplete?.(options.serverName).catch(() => undefined);
          }
        } finally {
          const terminalFrame: McpOAuthEvent = completed
            ? { type: "complete" }
            : (terminalError ?? {
                type: "error",
                code: "login_failed",
                message: "MCP OAuth sign-in ended unexpectedly",
              });
          stream.complete(terminalFrame);
        }
      })(),
    );

    return { sessionId, server: options.serverName };
  }

  subscribe(
    serverName: string,
    sessionId: string,
    onEvent: (event: McpOAuthEvent) => void,
    scopeKey = GLOBAL_MCP_OAUTH_SCOPE,
  ): () => void {
    return this.#requireSession(serverName, sessionId, scopeKey).stream.subscribe(onEvent);
  }

  submitInput(
    serverName: string,
    sessionId: string,
    redirectUrl: string,
    scopeKey = GLOBAL_MCP_OAUTH_SCOPE,
  ): void {
    const session = this.#requireSession(serverName, sessionId, scopeKey);
    if (session.stream.terminal) {
      throw new EngineError(
        409,
        "mcp_oauth_session_closed",
        `MCP OAuth session ${sessionId} has ended`,
      );
    }
    try {
      session.raw.submitRedirectUrl(redirectUrl);
    } catch (error) {
      if (error instanceof McpOAuthSessionError) {
        switch (error.code) {
          case "session_closed":
            throw new EngineError(409, "mcp_oauth_session_closed", error.message);
          case "not_waiting":
            throw new EngineError(409, "mcp_oauth_not_waiting", error.message);
          case "invalid_redirect":
            throw new EngineError(400, "invalid_request", error.message);
        }
      }
      throw new EngineError(
        400,
        "invalid_request",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  cancel(serverName: string, sessionId: string, scopeKey = GLOBAL_MCP_OAUTH_SCOPE): void {
    const session = this.#requireSession(serverName, sessionId, scopeKey);
    if (session.stream.terminal) return;
    session.raw.cancel();
  }

  async cancelForServer(serverName: string, scopeKey?: string): Promise<void> {
    await this.cancelAllForServers([serverName], scopeKey);
  }

  async cancelAllForServers(serverNames: Iterable<string>, scopeKey?: string): Promise<void> {
    const targets = new Set(serverNames);
    if (targets.size === 0) return;
    const pending: Promise<void>[] = [];
    for (const session of this.#sessions.values()) {
      if (
        targets.has(session.serverName) &&
        (scopeKey === undefined || session.scopeKey === scopeKey) &&
        !session.stream.terminal
      ) {
        session.raw.cancel();
        pending.push(session.stream.done);
      }
    }
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  async cancelForScope(scopeKey: string): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const session of this.#sessions.values()) {
      if (session.scopeKey === scopeKey && !session.stream.terminal) {
        session.raw.cancel();
        pending.push(session.stream.done);
      }
    }
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const session of this.#sessions.values()) {
      session.stream.cancelCleanup();
      if (!session.stream.terminal) {
        session.raw.cancel();
      }
    }
    await this.#startQueue.drainAll();
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) {
      session.stream.cancelCleanup();
      if (!session.stream.terminal) {
        session.raw.cancel();
      }
    }
    await Promise.allSettled(sessions.map((session) => session.stream.done));
    for (const session of sessions) {
      session.stream.dispose();
    }
    this.#sessions.clear();
  }

  #requireSession(
    serverName: string,
    sessionId: string,
    scopeKey = GLOBAL_MCP_OAUTH_SCOPE,
  ): ManagedOAuthSession {
    const session = this.#sessions.get(sessionId);
    if (
      session === undefined ||
      session.serverName !== serverName ||
      session.scopeKey !== scopeKey
    ) {
      throw new EngineError(
        404,
        "mcp_oauth_session_not_found",
        `Unknown MCP OAuth session ${sessionId}`,
      );
    }
    return session;
  }
}
