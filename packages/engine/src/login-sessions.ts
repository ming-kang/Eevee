import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, Models } from "@earendil-works/pi-ai";
import type {
  AuthType,
  LoginAuthEvent,
  LoginCompleteEvent,
  LoginErrorEvent,
  LoginInputRequest,
  LoginPromptEvent,
  StartLoginResponse,
} from "@eevee/protocol";
import { EngineError } from "./engine-error.ts";

export type LoginSseFrame =
  | { readonly event: "auth"; readonly data: LoginAuthEvent }
  | { readonly event: "prompt"; readonly data: LoginPromptEvent }
  | { readonly event: "complete"; readonly data: LoginCompleteEvent }
  | { readonly event: "error"; readonly data: LoginErrorEvent };

type PendingPrompt = {
  readonly promptId: string;
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
};

type LoginSession = {
  readonly sessionId: string;
  readonly providerId: string;
  readonly type: AuthType;
  readonly abortController: AbortController;
  readonly history: LoginSseFrame[];
  readonly subscribers: Set<(frame: LoginSseFrame) => void>;
  pendingPrompt?: PendingPrompt;
  terminal: boolean;
  cancelled: boolean;
  done: Promise<void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

const SESSION_RETENTION_MS = 60_000;

function serializeAuthEvent(event: AuthEvent): LoginAuthEvent {
  switch (event.type) {
    case "info":
      return {
        type: "info",
        message: event.message,
        ...(event.links === undefined
          ? {}
          : {
              links: event.links.map((link) => ({
                url: link.url,
                ...(link.label === undefined ? {} : { label: link.label }),
              })),
            }),
      };
    case "auth_url":
      return {
        type: "auth_url",
        url: event.url,
        ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
      };
    case "device_code":
      return {
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.openBrowserOnConfirm === undefined
          ? {}
          : { openBrowserOnConfirm: event.openBrowserOnConfirm }),
        ...(event.copyCodeOnConfirm === undefined
          ? {}
          : { copyCodeOnConfirm: event.copyCodeOnConfirm }),
        ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
        ...(event.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: event.expiresInSeconds }),
      };
    case "progress":
      return { type: "progress", message: event.message };
  }
}

function serializePrompt(promptId: string, prompt: AuthPrompt): LoginPromptEvent {
  if (prompt.type === "select") {
    return {
      promptId,
      type: "select",
      message: prompt.message,
      options: prompt.options.map((opt) => ({
        id: opt.id,
        label: opt.label,
        ...(opt.description === undefined ? {} : { description: opt.description }),
      })),
    };
  }
  return {
    promptId,
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
  };
}

export class LoginSessionManager {
  readonly #sessions = new Map<string, LoginSession>();
  #closed = false;

  start(models: Models, providerId: string, type: AuthType): StartLoginResponse {
    if (this.#closed) {
      throw new EngineError(503, "engine_closed", "Engine is closing");
    }
    const provider = models.getProvider(providerId);
    if (provider === undefined) {
      throw new EngineError(404, "provider_not_found", `Unknown provider ${providerId}`);
    }
    const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
    if (!method?.login) {
      throw new EngineError(
        400,
        "auth_unsupported",
        `Provider ${providerId} does not support ${type} login`,
      );
    }

    const sessionId = randomUUID();
    const abortController = new AbortController();
    const session: LoginSession = {
      sessionId,
      providerId,
      type,
      abortController,
      history: [],
      subscribers: new Set(),
      terminal: false,
      cancelled: false,
      done: Promise.resolve(),
    };
    this.#sessions.set(sessionId, session);

    const emit = (frame: LoginSseFrame): void => {
      session.history.push(frame);
      for (const subscriber of [...session.subscribers]) {
        try {
          subscriber(frame);
        } catch {
          // Isolate stream subscriber failures.
        }
      }
    };

    const scheduleCleanup = (): void => {
      if (this.#closed) return;
      session.cleanupTimer = setTimeout(() => {
        this.#sessions.delete(sessionId);
      }, SESSION_RETENTION_MS);
      session.cleanupTimer.unref?.();
    };

    session.done = (async () => {
      try {
        await models.login(
          providerId,
          type,
          {
            signal: abortController.signal,
            notify: (event) => {
              if (!session.terminal) emit({ event: "auth", data: serializeAuthEvent(event) });
            },
            prompt: (prompt) =>
              new Promise<string>((resolve, reject) => {
                if (abortController.signal.aborted || session.terminal) {
                  reject(new Error("Login cancelled"));
                  return;
                }
                if (prompt.signal?.aborted) {
                  reject(
                    prompt.signal.reason instanceof Error
                      ? prompt.signal.reason
                      : new Error("Prompt aborted"),
                  );
                  return;
                }
                const promptId = randomUUID();
                let onPromptAbort: (() => void) | undefined;
                const cleanup = () => {
                  if (prompt.signal !== undefined && onPromptAbort !== undefined) {
                    prompt.signal.removeEventListener("abort", onPromptAbort);
                  }
                };
                if (prompt.signal !== undefined) {
                  onPromptAbort = () => {
                    if (session.pendingPrompt?.promptId === promptId) {
                      session.pendingPrompt = undefined;
                    }
                    const reason = prompt.signal?.reason;
                    reject(reason instanceof Error ? reason : new Error("Prompt aborted"));
                  };
                  prompt.signal.addEventListener("abort", onPromptAbort, { once: true });
                }
                session.pendingPrompt = {
                  promptId,
                  resolve: (value) => {
                    cleanup();
                    resolve(value);
                  },
                  reject: (error) => {
                    cleanup();
                    reject(error);
                  },
                };
                emit({ event: "prompt", data: serializePrompt(promptId, prompt) });
              }),
          },
          { agentName: "eevee" },
        );

        session.pendingPrompt = undefined;
        session.terminal = true;
        emit({ event: "complete", data: { providerId, type } });
      } catch (error) {
        const pending = session.pendingPrompt;
        session.pendingPrompt = undefined;
        pending?.reject(error instanceof Error ? error : new Error(String(error)));
        session.terminal = true;
        const code = session.cancelled ? "login_cancelled" : "login_failed";
        const message = session.cancelled
          ? "Login cancelled"
          : error instanceof Error
            ? error.message
            : String(error);
        emit({ event: "error", data: { code, message } });
      } finally {
        session.subscribers.clear();
        scheduleCleanup();
      }
    })();

    return { sessionId, providerId, type };
  }

  subscribe(
    providerId: string,
    sessionId: string,
    onFrame: (frame: LoginSseFrame) => void,
  ): () => void {
    const session = this.#requireSession(providerId, sessionId);
    for (const frame of session.history) {
      onFrame(frame);
    }
    if (session.terminal) {
      return () => {};
    }
    session.subscribers.add(onFrame);
    return () => {
      session.subscribers.delete(onFrame);
    };
  }

  submitInput(providerId: string, sessionId: string, input: LoginInputRequest): void {
    const session = this.#requireSession(providerId, sessionId);
    if (session.terminal) {
      throw new EngineError(409, "login_session_closed", `Login session ${sessionId} has ended`);
    }
    if (session.pendingPrompt === undefined || session.pendingPrompt.promptId !== input.promptId) {
      throw new EngineError(
        409,
        "prompt_not_pending",
        `No pending login prompt matches ${input.promptId}`,
      );
    }
    const pending = session.pendingPrompt;
    session.pendingPrompt = undefined;
    pending.resolve(input.value);
  }

  cancel(providerId: string, sessionId: string): void {
    const session = this.#requireSession(providerId, sessionId);
    if (session.terminal) return;
    session.cancelled = true;
    const pending = session.pendingPrompt;
    session.pendingPrompt = undefined;
    pending?.reject(new Error("Login cancelled"));
    session.abortController.abort(new Error("Login cancelled"));
  }

  async close(): Promise<void> {
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) {
      if (session.cleanupTimer !== undefined) {
        clearTimeout(session.cleanupTimer);
        session.cleanupTimer = undefined;
      }
      if (!session.terminal) {
        session.cancelled = true;
        const pending = session.pendingPrompt;
        session.pendingPrompt = undefined;
        pending?.reject(new Error("Engine is closing"));
        session.abortController.abort(new Error("Engine is closing"));
      }
    }
    await Promise.allSettled(sessions.map((session) => session.done));
    this.#sessions.clear();
  }

  #requireSession(providerId: string, sessionId: string): LoginSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.providerId !== providerId) {
      throw new EngineError(404, "login_session_not_found", `Unknown login session ${sessionId}`);
    }
    return session;
  }
}
