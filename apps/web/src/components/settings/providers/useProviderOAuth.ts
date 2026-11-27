import type { LoginAuthEvent, LoginPromptEvent, LoginStreamEvent } from "@eevee/protocol";
import { useCallback, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { useAbortableSessionStream } from "../useAbortableStream.ts";

export type IndexedAuthEvent = {
  readonly id: number;
  readonly event: LoginAuthEvent;
};

let nextAuthEventId = 1;

export type ActiveProviderLogin = {
  readonly providerId: string;
  readonly sessionId: string;
  readonly authEvents: readonly IndexedAuthEvent[];
  readonly prompt?: LoginPromptEvent;
  readonly done?: string;
  readonly error?: string;
};

export function createActiveProviderLogin(
  providerId: string,
  sessionId: string,
): ActiveProviderLogin {
  return { providerId, sessionId, authEvents: [] };
}

export function applyProviderOAuthEvent(
  prev: ActiveProviderLogin | undefined,
  sessionId: string,
  event: LoginStreamEvent,
): ActiveProviderLogin | undefined {
  if (!prev || prev.sessionId !== sessionId) return prev;
  switch (event.type) {
    case "auth":
      return {
        ...prev,
        authEvents: [...prev.authEvents, { id: nextAuthEventId++, event: event.event }],
      };
    case "prompt":
      return { ...prev, prompt: event.prompt };
    case "complete":
      return { ...prev, prompt: undefined, done: `${event.complete.providerId} 已完成登录` };
    case "error":
      return { ...prev, prompt: undefined, error: event.error.message };
  }
}

export function markProviderOAuthUnexpectedEnd(
  prev: ActiveProviderLogin | undefined,
  sessionId: string,
): ActiveProviderLogin | undefined {
  if (!prev || prev.sessionId !== sessionId) return prev;
  return { ...prev, prompt: undefined, error: "OAuth 授权流意外中断" };
}

export type UseProviderOAuthOptions = {
  readonly onComplete: (providerId: string) => Promise<void>;
  readonly onError: (message: string | undefined) => void;
  readonly onSelectProvider?: (providerId: string) => void;
};

export type UseProviderOAuthResult = {
  readonly login: ActiveProviderLogin | undefined;
  readonly promptInput: string;
  readonly setPromptInput: (value: string) => void;
  readonly startOAuth: (providerId: string) => Promise<void>;
  readonly submitPrompt: () => Promise<void>;
  readonly cancelLogin: () => Promise<void>;
};

export function useProviderOAuth({
  onComplete,
  onError,
  onSelectProvider,
}: UseProviderOAuthOptions): UseProviderOAuthResult {
  const { abort, callbacksRef, runSession } = useAbortableSessionStream({
    onComplete,
    onError,
    onSelectProvider,
  });
  const [login, setLogin] = useState<ActiveProviderLogin | undefined>(undefined);
  const [promptInput, setPromptInput] = useState("");

  const loginRef = useRef(login);
  const promptInputRef = useRef(promptInput);
  loginRef.current = login;
  promptInputRef.current = promptInput;

  const startOAuth = useCallback(
    async (providerId: string) => {
      callbacksRef.current.onError(undefined);
      callbacksRef.current.onSelectProvider?.(providerId);

      await runSession<LoginStreamEvent>({
        open: async ({ signal, isCurrent }) => {
          const started = await api.startProviderLogin(providerId, { type: "oauth" }, signal);
          if (!isCurrent()) return undefined;
          setLogin(createActiveProviderLogin(providerId, started.sessionId));
          setPromptInput("");
          return {
            sessionId: started.sessionId,
            stream: api.streamLoginSession(providerId, started.sessionId, { signal }),
          };
        },
        isTerminal: (event) => event.type === "complete" || event.type === "error",
        onEvent: async (event, { sessionId, isCurrent, callbacks }) => {
          if (!isCurrent()) return;
          setLogin((prev) => applyProviderOAuthEvent(prev, sessionId, event));
          if (event.type === "prompt") {
            setPromptInput(
              event.prompt.type === "select" ? (event.prompt.options[0]?.id ?? "") : "",
            );
          } else if (event.type === "complete") {
            await callbacks.onComplete(providerId);
          }
        },
        onUnexpectedEnd: ({ sessionId }) => {
          setLogin((prev) => markProviderOAuthUnexpectedEnd(prev, sessionId));
        },
        onError: (err, { callbacks }) => {
          callbacks.onError(err instanceof Error ? err.message : String(err));
        },
      });
    },
    [callbacksRef, runSession],
  );

  const submitPrompt = useCallback(async () => {
    const active = loginRef.current;
    if (!active?.prompt) return;
    try {
      await api.submitLoginInput(active.providerId, active.sessionId, {
        promptId: active.prompt.promptId,
        value: promptInputRef.current,
      });
      setLogin((prev) =>
        prev && prev.sessionId === active.sessionId ? { ...prev, prompt: undefined } : prev,
      );
      setPromptInput("");
    } catch (err) {
      callbacksRef.current.onError(err instanceof Error ? err.message : String(err));
    }
  }, [callbacksRef]);

  const cancelLogin = useCallback(async () => {
    const active = loginRef.current;
    if (!active) return;
    abort();
    setLogin(undefined);
    if (!active.done && !active.error) {
      await api.cancelLoginSession(active.providerId, active.sessionId).catch(() => undefined);
    }
  }, [abort]);

  return {
    login,
    promptInput,
    setPromptInput,
    startOAuth,
    submitPrompt,
    cancelLogin,
  };
}
