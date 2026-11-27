import type { McpOAuthEvent } from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { showToast } from "../../lib/toasts.ts";
import { useAbortableSessionStream } from "./useAbortableStream.ts";

export type OAuthProgressEntry = {
  readonly id: number;
  readonly message: string;
};

let nextOAuthProgressId = 1;

export type OAuthUiSession = {
  readonly serverName: string;
  readonly sessionId: string;
  readonly authUrl?: string;
  readonly redirectHint?: string;
  readonly instructions?: string;
  readonly progress: readonly OAuthProgressEntry[];
  readonly redirectInput: string;
  readonly submittingInput: boolean;
  readonly done: boolean;
  readonly error?: string;
};

export function createOAuthUiSession(serverName: string, sessionId: string): OAuthUiSession {
  return {
    serverName,
    sessionId,
    progress: [],
    redirectInput: "",
    submittingInput: false,
    done: false,
  };
}

export function applyMcpOAuthEvent(
  prev: OAuthUiSession | undefined,
  sessionId: string,
  event: McpOAuthEvent,
): OAuthUiSession | undefined {
  if (!prev || prev.sessionId !== sessionId) return prev;
  switch (event.type) {
    case "auth_url":
      return {
        ...prev,
        authUrl: event.url,
        redirectHint: event.redirectUrl,
        instructions: event.instructions,
      };
    case "progress":
      return {
        ...prev,
        progress: [...prev.progress, { id: nextOAuthProgressId++, message: event.message }],
      };
    case "complete":
      return { ...prev, done: true };
    case "error":
      return { ...prev, error: event.message };
  }
}

export function markMcpOAuthUnexpectedEnd(
  prev: OAuthUiSession | undefined,
  sessionId: string,
): OAuthUiSession | undefined {
  if (!prev || prev.sessionId !== sessionId) return prev;
  return { ...prev, error: "OAuth 授权流意外中断" };
}

export type UseMcpOAuthOptions = {
  readonly projectId?: string;
  readonly onRefresh: () => Promise<void>;
  readonly onError: (message: string | undefined) => void;
};

export type UseMcpOAuthResult = {
  readonly oauthSession: OAuthUiSession | undefined;
  readonly oauthMutatingServers: Readonly<Record<string, boolean>>;
  readonly startOAuth: (serverName: string) => Promise<void>;
  readonly submitOAuthRedirect: () => Promise<void>;
  readonly cancelOAuth: () => Promise<void>;
  readonly logoutOAuth: (serverName: string) => Promise<void>;
  readonly setOAuthRedirectInput: (value: string) => void;
  readonly dismissOAuth: (serverName?: string) => void;
};

export function useMcpOAuth({
  projectId,
  onRefresh,
  onError,
}: UseMcpOAuthOptions): UseMcpOAuthResult {
  const client = useMemo(() => api.mcp(projectId), [projectId]);
  const { abort, callbacksRef, runSession } = useAbortableSessionStream({ onRefresh, onError });
  const [oauthSession, setOauthSession] = useState<OAuthUiSession | undefined>(undefined);
  const [oauthMutatingServers, setOauthMutatingServers] = useState<Record<string, boolean>>({});

  const activeClientRef = useRef(client);
  const oauthSessionRef = useRef(oauthSession);
  oauthSessionRef.current = oauthSession;

  useEffect(() => {
    activeClientRef.current = client;
    abort();
    setOauthSession(undefined);
    setOauthMutatingServers({});
  }, [client, abort]);

  const dismissOAuth = useCallback(
    (serverName?: string) => {
      if (serverName === undefined || oauthSessionRef.current?.serverName === serverName) {
        abort();
        setOauthSession(undefined);
      }
    },
    [abort],
  );

  const setOAuthRedirectInput = useCallback((value: string) => {
    setOauthSession((prev) => (prev ? { ...prev, redirectInput: value } : prev));
  }, []);

  const startOAuth = useCallback(
    async (serverName: string) => {
      callbacksRef.current.onError(undefined);

      await runSession<McpOAuthEvent>({
        open: async ({ signal, isCurrent }) => {
          const started = await client.startOAuth(serverName, signal);
          if (!isCurrent() || activeClientRef.current !== client) return undefined;
          setOauthSession(createOAuthUiSession(serverName, started.sessionId));
          return {
            sessionId: started.sessionId,
            stream: client.streamOAuth(serverName, started.sessionId, { signal }),
          };
        },
        isTerminal: (ev) => ev.type === "complete" || ev.type === "error",
        onEvent: async (ev, { sessionId, isCurrent, callbacks }) => {
          if (activeClientRef.current !== client) return;
          if (ev.type === "error" && !isCurrent()) return;
          setOauthSession((prev) => applyMcpOAuthEvent(prev, sessionId, ev));
          if (ev.type === "complete") {
            showToast(`${serverName} OAuth 登录成功`);
            await callbacks.onRefresh();
          }
        },
        onUnexpectedEnd: ({ sessionId }) => {
          if (activeClientRef.current !== client) return;
          setOauthSession((prev) => markMcpOAuthUnexpectedEnd(prev, sessionId));
        },
        onError: (err, { callbacks }) => {
          if (activeClientRef.current !== client) return;
          const msg = err instanceof Error ? err.message : String(err);
          setOauthSession((prev) =>
            prev && prev.serverName === serverName ? { ...prev, error: msg } : prev,
          );
          callbacks.onError(msg);
        },
      });
    },
    [callbacksRef, client, runSession],
  );

  const submitOAuthRedirect = useCallback(async () => {
    const active = oauthSessionRef.current;
    if (!active) return;
    const redirectUrl = active.redirectInput.trim();
    if (!redirectUrl) return;
    setOauthSession((prev) =>
      prev && prev.sessionId === active.sessionId
        ? { ...prev, submittingInput: true, error: undefined }
        : prev,
    );
    try {
      await client.submitOAuthInput(active.serverName, active.sessionId, {
        redirectUrl,
      });
      if (activeClientRef.current !== client) return;
      setOauthSession((prev) =>
        prev && prev.sessionId === active.sessionId
          ? {
              ...prev,
              submittingInput: false,
              redirectInput: "",
              progress: [
                ...prev.progress,
                { id: nextOAuthProgressId++, message: "已提交回调 URL，等待验证完成…" },
              ],
            }
          : prev,
      );
    } catch (err) {
      if (activeClientRef.current !== client) return;
      setOauthSession((prev) =>
        prev && prev.sessionId === active.sessionId
          ? {
              ...prev,
              submittingInput: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : prev,
      );
    }
  }, [client]);

  const cancelOAuth = useCallback(async () => {
    const active = oauthSessionRef.current;
    if (!active) return;
    abort();
    setOauthSession(undefined);
    if (!active.done && !active.error) {
      await client.cancelOAuth(active.serverName, active.sessionId).catch(() => undefined);
    }
  }, [abort, client]);

  const logoutOAuth = useCallback(
    async (serverName: string) => {
      setOauthMutatingServers((prev) => ({ ...prev, [serverName]: true }));
      callbacksRef.current.onError(undefined);
      try {
        await client.logoutOAuth(serverName);
        if (activeClientRef.current !== client) return;
        setOauthSession((prev) => {
          if (prev?.serverName === serverName) {
            abort();
            return undefined;
          }
          return prev;
        });
        await callbacksRef.current.onRefresh();
        if (activeClientRef.current !== client) return;
        showToast(`已清除「${serverName}」的 OAuth 凭据`);
      } catch (err) {
        if (activeClientRef.current === client) {
          callbacksRef.current.onError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (activeClientRef.current === client) {
          setOauthMutatingServers((prev) => {
            const copy = { ...prev };
            delete copy[serverName];
            return copy;
          });
        }
      }
    },
    [abort, callbacksRef, client],
  );

  return {
    oauthSession,
    oauthMutatingServers,
    startOAuth,
    submitOAuthRedirect,
    cancelOAuth,
    logoutOAuth,
    setOAuthRedirectInput,
    dismissOAuth,
  };
}
