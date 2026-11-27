import type { McpOAuthEvent } from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { showToast } from "../../lib/toasts.ts";
import { useAbortableStream } from "./useAbortableStream.ts";

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
  const { abort, run } = useAbortableStream();
  const [oauthSession, setOauthSession] = useState<OAuthUiSession | undefined>(undefined);
  const [oauthMutatingServers, setOauthMutatingServers] = useState<Record<string, boolean>>({});

  const activeClientRef = useRef(client);
  const onRefreshRef = useRef(onRefresh);
  const onErrorRef = useRef(onError);
  onRefreshRef.current = onRefresh;
  onErrorRef.current = onError;

  useEffect(() => {
    activeClientRef.current = client;
    abort();
    setOauthSession(undefined);
    setOauthMutatingServers({});
  }, [client, abort]);

  const dismissOAuth = useCallback(
    (serverName?: string) => {
      if (serverName === undefined || oauthSession?.serverName === serverName) {
        abort();
        setOauthSession(undefined);
      }
    },
    [abort, oauthSession],
  );

  const setOAuthRedirectInput = useCallback((value: string) => {
    setOauthSession((prev) => (prev ? { ...prev, redirectInput: value } : prev));
  }, []);

  const startOAuth = useCallback(
    async (serverName: string) => {
      onErrorRef.current(undefined);
      let startedSessionId: string | undefined;
      let sawTerminal = false;

      await run<McpOAuthEvent>({
        open: async ({ signal, isCurrent }) => {
          const started = await client.startOAuth(serverName, signal);
          if (!isCurrent() || activeClientRef.current !== client) return undefined;
          startedSessionId = started.sessionId;
          setOauthSession({
            serverName,
            sessionId: started.sessionId,
            progress: [],
            redirectInput: "",
            submittingInput: false,
            done: false,
          });
          return client.streamOAuth(serverName, started.sessionId, { signal });
        },
        onEvent: async (ev, { isCurrent }) => {
          if (activeClientRef.current !== client) return;
          if (ev.type === "auth_url") {
            setOauthSession((prev) =>
              prev && prev.sessionId === startedSessionId
                ? {
                    ...prev,
                    authUrl: ev.url,
                    redirectHint: ev.redirectUrl,
                    instructions: ev.instructions,
                  }
                : prev,
            );
          } else if (ev.type === "progress") {
            setOauthSession((prev) =>
              prev && prev.sessionId === startedSessionId
                ? {
                    ...prev,
                    progress: [
                      ...prev.progress,
                      { id: nextOAuthProgressId++, message: ev.message },
                    ],
                  }
                : prev,
            );
          } else if (ev.type === "complete") {
            sawTerminal = true;
            setOauthSession((prev) =>
              prev && prev.sessionId === startedSessionId ? { ...prev, done: true } : prev,
            );
            showToast(`${serverName} OAuth 登录成功`);
            await onRefreshRef.current();
          } else if (ev.type === "error") {
            sawTerminal = true;
            if (!isCurrent()) return;
            setOauthSession((prev) =>
              prev && prev.sessionId === startedSessionId ? { ...prev, error: ev.message } : prev,
            );
          }
        },
        onEnd: () => {
          if (!sawTerminal && startedSessionId && activeClientRef.current === client) {
            setOauthSession((prev) =>
              prev && prev.sessionId === startedSessionId
                ? { ...prev, error: "OAuth 授权流意外中断" }
                : prev,
            );
          }
        },
        onError: (err) => {
          if (activeClientRef.current !== client) return;
          const msg = err instanceof Error ? err.message : String(err);
          setOauthSession((prev) =>
            prev && prev.serverName === serverName ? { ...prev, error: msg } : prev,
          );
          onErrorRef.current(msg);
        },
      });
    },
    [client, run],
  );

  const submitOAuthRedirect = useCallback(async () => {
    if (!oauthSession) return;
    const redirectUrl = oauthSession.redirectInput.trim();
    if (!redirectUrl) return;
    setOauthSession((prev) => (prev ? { ...prev, submittingInput: true, error: undefined } : prev));
    try {
      await client.submitOAuthInput(oauthSession.serverName, oauthSession.sessionId, {
        redirectUrl,
      });
      if (activeClientRef.current !== client) return;
      setOauthSession((prev) =>
        prev && prev.sessionId === oauthSession.sessionId
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
        prev && prev.sessionId === oauthSession.sessionId
          ? {
              ...prev,
              submittingInput: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : prev,
      );
    }
  }, [client, oauthSession]);

  const cancelOAuth = useCallback(async () => {
    if (!oauthSession) return;
    const active = oauthSession;
    abort();
    setOauthSession(undefined);
    if (!active.done && !active.error) {
      await client.cancelOAuth(active.serverName, active.sessionId).catch(() => undefined);
    }
  }, [abort, client, oauthSession]);

  const logoutOAuth = useCallback(
    async (serverName: string) => {
      setOauthMutatingServers((prev) => ({ ...prev, [serverName]: true }));
      onErrorRef.current(undefined);
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
        await onRefreshRef.current();
        if (activeClientRef.current !== client) return;
        showToast(`已清除「${serverName}」的 OAuth 凭据`);
      } catch (err) {
        if (activeClientRef.current === client) {
          onErrorRef.current(err instanceof Error ? err.message : String(err));
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
    [abort, client],
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
