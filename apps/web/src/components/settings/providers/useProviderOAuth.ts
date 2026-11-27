import type { LoginAuthEvent, LoginPromptEvent, LoginStreamEvent } from "@eevee/protocol";
import { useCallback, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { useAbortableStream } from "../useAbortableStream.ts";

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
  const { abort, run } = useAbortableStream();
  const [login, setLogin] = useState<ActiveProviderLogin | undefined>(undefined);
  const [promptInput, setPromptInput] = useState("");

  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  const onSelectProviderRef = useRef(onSelectProvider);
  onCompleteRef.current = onComplete;
  onErrorRef.current = onError;
  onSelectProviderRef.current = onSelectProvider;

  const startOAuth = useCallback(
    async (providerId: string) => {
      onErrorRef.current(undefined);
      onSelectProviderRef.current?.(providerId);
      let activeSessionId: string | undefined;
      let sawTerminal = false;

      await run<LoginStreamEvent>({
        open: async ({ signal, isCurrent }) => {
          const started = await api.startProviderLogin(providerId, { type: "oauth" }, signal);
          if (!isCurrent()) return undefined;
          activeSessionId = started.sessionId;
          setLogin({ providerId, sessionId: started.sessionId, authEvents: [] });
          setPromptInput("");
          return api.streamLoginSession(providerId, started.sessionId, { signal });
        },
        onEvent: async (event, { isCurrent }) => {
          if (!isCurrent()) return;
          if (event.type === "auth") {
            setLogin((prev) =>
              prev && prev.sessionId === activeSessionId
                ? {
                    ...prev,
                    authEvents: [...prev.authEvents, { id: nextAuthEventId++, event: event.event }],
                  }
                : prev,
            );
          } else if (event.type === "prompt") {
            setLogin((prev) =>
              prev && prev.sessionId === activeSessionId ? { ...prev, prompt: event.prompt } : prev,
            );
            setPromptInput(
              event.prompt.type === "select" ? (event.prompt.options[0]?.id ?? "") : "",
            );
          } else if (event.type === "complete") {
            sawTerminal = true;
            setLogin((prev) =>
              prev && prev.sessionId === activeSessionId
                ? { ...prev, prompt: undefined, done: `${event.complete.providerId} 已完成登录` }
                : prev,
            );
            await onCompleteRef.current(providerId);
          } else if (event.type === "error") {
            sawTerminal = true;
            setLogin((prev) =>
              prev && prev.sessionId === activeSessionId
                ? { ...prev, prompt: undefined, error: event.error.message }
                : prev,
            );
          }
        },
        onEnd: () => {
          if (!sawTerminal && activeSessionId) {
            setLogin((prev) =>
              prev && prev.sessionId === activeSessionId
                ? { ...prev, prompt: undefined, error: "OAuth 授权流意外中断" }
                : prev,
            );
          }
        },
        onError: (err) => {
          onErrorRef.current(err instanceof Error ? err.message : String(err));
        },
      });
    },
    [run],
  );

  const submitPrompt = useCallback(async () => {
    if (!login?.prompt) return;
    try {
      await api.submitLoginInput(login.providerId, login.sessionId, {
        promptId: login.prompt.promptId,
        value: promptInput,
      });
      setLogin((prev) => (prev ? { ...prev, prompt: undefined } : prev));
      setPromptInput("");
    } catch (err) {
      onErrorRef.current(err instanceof Error ? err.message : String(err));
    }
  }, [login, promptInput]);

  const cancelLogin = useCallback(async () => {
    if (!login) return;
    const active = login;
    abort();
    setLogin(undefined);
    if (!active.done && !active.error) {
      await api.cancelLoginSession(active.providerId, active.sessionId).catch(() => undefined);
    }
  }, [abort, login]);

  return {
    login,
    promptInput,
    setPromptInput,
    startOAuth,
    submitPrompt,
    cancelLogin,
  };
}
