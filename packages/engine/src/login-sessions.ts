import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, Models } from "@earendil-works/pi-ai";
import type {
  AuthType,
  LoginAuthEvent,
  LoginCompleteEvent,
  LoginErrorEvent,
  LoginInputRequest,
  LoginPromptEvent,
  OkResponse,
  StartLoginResponse,
} from "@eevee/protocol";
import { EngineError } from "./engine-error.ts";
import { KeyedSessionRegistry } from "./session-registry.ts";
import type { BufferedSessionStream } from "./session-stream.ts";

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
  readonly stream: BufferedSessionStream<LoginSseFrame>;
  pendingPrompt?: PendingPrompt;
  cancelled: boolean;
};

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

function cancelLoginSession(session: LoginSession, reason: string): void {
  if (session.stream.terminal) return;
  session.cancelled = true;
  const pending = session.pendingPrompt;
  session.pendingPrompt = undefined;
  pending?.reject(new Error(reason));
  session.abortController.abort(new Error(reason));
}

export class LoginSessionManager {
  readonly #registry = new KeyedSessionRegistry<LoginSession, LoginSseFrame>();

  async start(models: Models, providerId: string, type: AuthType): Promise<StartLoginResponse> {
    const session = await this.#registry.start(providerId, () => {
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
      const stream = this.#registry.createStream(() => sessionId);
      const entry: LoginSession = {
        sessionId,
        providerId,
        type,
        abortController,
        stream,
        cancelled: false,
      };

      stream.track(
        (async () => {
          try {
            await models.login(
              providerId,
              type,
              {
                signal: abortController.signal,
                notify: (event) => {
                  stream.emit({ event: "auth", data: serializeAuthEvent(event) });
                },
                prompt: (prompt) =>
                  new Promise<string>((resolve, reject) => {
                    if (abortController.signal.aborted || stream.terminal) {
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
                        if (entry.pendingPrompt?.promptId === promptId) {
                          entry.pendingPrompt = undefined;
                        }
                        const reason = prompt.signal?.reason;
                        reject(reason instanceof Error ? reason : new Error("Prompt aborted"));
                      };
                      prompt.signal.addEventListener("abort", onPromptAbort, { once: true });
                    }
                    entry.pendingPrompt = {
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
                    stream.emit({ event: "prompt", data: serializePrompt(promptId, prompt) });
                  }),
              },
              { agentName: "eevee" },
            );

            entry.pendingPrompt = undefined;
            stream.complete({ event: "complete", data: { providerId, type } });
          } catch (error) {
            const pending = entry.pendingPrompt;
            entry.pendingPrompt = undefined;
            pending?.reject(error instanceof Error ? error : new Error(String(error)));
            const code = entry.cancelled ? "login_cancelled" : "login_failed";
            const message = entry.cancelled
              ? "Login cancelled"
              : error instanceof Error
                ? error.message
                : String(error);
            stream.complete({ event: "error", data: { code, message } });
          }
        })(),
      );

      return entry;
    });

    return { sessionId: session.sessionId, providerId, type };
  }

  subscribe(
    providerId: string,
    sessionId: string,
    onFrame: (frame: LoginSseFrame) => void,
  ): () => void {
    return this.#requireSession(providerId, sessionId).stream.subscribe(onFrame);
  }

  submitInput(providerId: string, sessionId: string, input: LoginInputRequest): OkResponse {
    const session = this.#requireSession(providerId, sessionId);
    if (session.stream.terminal) {
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
    return { ok: true };
  }

  cancel(providerId: string, sessionId: string): OkResponse {
    const session = this.#requireSession(providerId, sessionId);
    cancelLoginSession(session, "Login cancelled");
    return { ok: true };
  }

  close(): Promise<void> {
    return this.#registry.close((session) => cancelLoginSession(session, "Engine is closing"));
  }

  #requireSession(providerId: string, sessionId: string): LoginSession {
    return this.#registry.require(
      sessionId,
      (session) => session.providerId === providerId,
      () => new EngineError(404, "login_session_not_found", `Unknown login session ${sessionId}`),
    );
  }
}
