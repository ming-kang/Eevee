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
import { KeyedSessionRegistry } from "./session-registry.ts";
import type { BufferedSessionStream } from "./session-stream.ts";

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
  cancelled: boolean;
  completing: boolean;
};

function cancelOAuthSession(session: ManagedOAuthSession): void {
  session.cancelled = true;
  session.raw.cancel();
}

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
  readonly #registry = new KeyedSessionRegistry<ManagedOAuthSession, McpOAuthEvent>();

  async start(options: StartMcpOAuthSessionOptions): Promise<StartMcpOAuthResponse> {
    const scopeKey = options.scopeKey ?? GLOBAL_MCP_OAUTH_SCOPE;
    const chainKey = `${scopeKey}:${options.serverName}`;
    const managed = await this.#registry.start(chainKey, async () => {
      await this.cancelForServer(options.serverName, scopeKey);
      this.#registry.assertOpen();
      options.beforeStart?.();

      let completed = false;
      let terminalError: McpOAuthEvent | undefined;
      let sessionId = "";
      const stream = this.#registry.createStream(() => sessionId);

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
      const entry: ManagedOAuthSession = {
        sessionId,
        scopeKey,
        serverName: options.serverName,
        raw,
        stream,
        cancelled: false,
        completing: false,
      };

      stream.track(
        (async () => {
          try {
            await raw.done;
            if (completed && !entry.cancelled && !this.#registry.closed) {
              entry.completing = true;
              try {
                await options.onComplete?.(options.serverName).catch(() => undefined);
              } finally {
                entry.completing = false;
              }
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

      return entry;
    });

    return { sessionId: managed.sessionId, server: options.serverName };
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
    cancelOAuthSession(session);
  }

  async cancelForServer(serverName: string, scopeKey?: string): Promise<void> {
    await this.cancelAllForServers([serverName], scopeKey);
  }

  async cancelAllForServers(serverNames: Iterable<string>, scopeKey?: string): Promise<void> {
    const targets = new Set(serverNames);
    if (targets.size === 0) return;
    await this.#registry.cancelWhere(
      (session) =>
        targets.has(session.serverName) &&
        (scopeKey === undefined || session.scopeKey === scopeKey),
      cancelOAuthSession,
      (session) => (session.completing ? session.raw.done : session.stream.done),
    );
  }

  async cancelForScope(scopeKey: string): Promise<void> {
    await this.#registry.cancelWhere(
      (session) => session.scopeKey === scopeKey,
      cancelOAuthSession,
      (session) => (session.completing ? session.raw.done : session.stream.done),
    );
  }

  close(): Promise<void> {
    return this.#registry.close(cancelOAuthSession);
  }

  #requireSession(
    serverName: string,
    sessionId: string,
    scopeKey = GLOBAL_MCP_OAUTH_SCOPE,
  ): ManagedOAuthSession {
    return this.#registry.require(
      sessionId,
      (session) => session.serverName === serverName && session.scopeKey === scopeKey,
      () =>
        new EngineError(
          404,
          "mcp_oauth_session_not_found",
          `Unknown MCP OAuth session ${sessionId}`,
        ),
    );
  }
}
