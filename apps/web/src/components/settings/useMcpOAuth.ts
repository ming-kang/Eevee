import type { McpOAuthEvent } from "@eevee/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { showToast } from "../../lib/toasts.ts";

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
  const [oauthSession, setOauthSession] = useState<OAuthUiSession | undefined>(undefined);
  const [oauthMutatingServers, setOauthMutatingServers] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | undefined>(undefined);
  const activeProjectIdRef = useRef(projectId);
  const onRefreshRef = useRef(onRefresh);
  const onErrorRef = useRef(onError);

  onRefreshRef.current = onRefresh;
  onErrorRef.current = onError;

  useEffect(() => {
    activeProjectIdRef.current = projectId;
    abortRef.current?.abort();
    setOauthSession(undefined);
    setOauthMutatingServers({});
    return () => {
      abortRef.current?.abort();
    };
  }, [projectId]);

  const dismissOAuth = useCallback(
    (serverName?: string) => {
      if (serverName === undefined || oauthSession?.serverName === serverName) {
        abortRef.current?.abort();
        setOauthSession(undefined);
      }
    },
    [oauthSession],
  );

  const setOAuthRedirectInput = useCallback((value: string) => {
    setOauthSession((prev) => (prev ? { ...prev, redirectInput: value } : prev));
  }, []);

  const startOAuth = useCallback(
    async (serverName: string) => {
      const activeProjectId = projectId;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      onErrorRef.current(undefined);

      try {
        const started =
          activeProjectId !== undefined
            ? await api.startProjectMcpOAuth(activeProjectId, serverName, controller.signal)
            : await api.startMcpOAuth(serverName, controller.signal);

        if (controller.signal.aborted || activeProjectIdRef.current !== activeProjectId) return;

        setOauthSession({
          serverName,
          sessionId: started.sessionId,
          progress: [],
          redirectInput: "",
          submittingInput: false,
          done: false,
        });

        const stream =
          activeProjectId !== undefined
            ? api.streamProjectMcpOAuth(activeProjectId, serverName, started.sessionId, {
                signal: controller.signal,
              })
            : api.streamMcpOAuth(serverName, started.sessionId, { signal: controller.signal });

        let sawTerminal = false;
        for await (const event of stream) {
          if (controller.signal.aborted || activeProjectIdRef.current !== activeProjectId) return;
          const ev: McpOAuthEvent = event;
          if (ev.type === "auth_url") {
            setOauthSession((prev) =>
              prev && prev.sessionId === started.sessionId
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
              prev && prev.sessionId === started.sessionId
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
              prev && prev.sessionId === started.sessionId ? { ...prev, done: true } : prev,
            );
            showToast(`${serverName} OAuth 登录成功`);
            await onRefreshRef.current();
          } else if (ev.type === "error") {
            sawTerminal = true;
            setOauthSession((prev) =>
              prev && prev.sessionId === started.sessionId ? { ...prev, error: ev.message } : prev,
            );
          }
        }

        if (
          !sawTerminal &&
          !controller.signal.aborted &&
          activeProjectIdRef.current === activeProjectId
        ) {
          setOauthSession((prev) =>
            prev && prev.sessionId === started.sessionId
              ? { ...prev, error: "OAuth 授权流意外中断" }
              : prev,
          );
        }
      } catch (err) {
        if (!controller.signal.aborted && activeProjectIdRef.current === activeProjectId) {
          const msg = err instanceof Error ? err.message : String(err);
          setOauthSession((prev) =>
            prev && prev.serverName === serverName ? { ...prev, error: msg } : prev,
          );
          onErrorRef.current(msg);
        }
      }
    },
    [projectId],
  );

  const submitOAuthRedirect = useCallback(async () => {
    if (!oauthSession) return;
    const activeProjectId = projectId;
    const redirectUrl = oauthSession.redirectInput.trim();
    if (!redirectUrl) return;
    setOauthSession((prev) => (prev ? { ...prev, submittingInput: true, error: undefined } : prev));
    try {
      if (activeProjectId !== undefined) {
        await api.submitProjectMcpOAuthInput(
          activeProjectId,
          oauthSession.serverName,
          oauthSession.sessionId,
          { redirectUrl },
        );
      } else {
        await api.submitMcpOAuthInput(oauthSession.serverName, oauthSession.sessionId, {
          redirectUrl,
        });
      }
      if (activeProjectIdRef.current !== activeProjectId) return;
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
      if (activeProjectIdRef.current !== activeProjectId) return;
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
  }, [oauthSession, projectId]);

  const cancelOAuth = useCallback(async () => {
    if (!oauthSession) return;
    const activeProjectId = projectId;
    const active = oauthSession;
    abortRef.current?.abort();
    setOauthSession(undefined);
    if (!active.done && !active.error) {
      if (activeProjectId !== undefined) {
        await api
          .cancelProjectMcpOAuth(activeProjectId, active.serverName, active.sessionId)
          .catch(() => undefined);
      } else {
        await api.cancelMcpOAuth(active.serverName, active.sessionId).catch(() => undefined);
      }
    }
  }, [oauthSession, projectId]);

  const logoutOAuth = useCallback(
    async (serverName: string) => {
      const activeProjectId = projectId;
      setOauthMutatingServers((prev) => ({ ...prev, [serverName]: true }));
      onErrorRef.current(undefined);
      try {
        if (activeProjectId !== undefined) {
          await api.logoutProjectMcpOAuth(activeProjectId, serverName);
        } else {
          await api.logoutMcpOAuth(serverName);
        }
        if (activeProjectIdRef.current !== activeProjectId) return;
        setOauthSession((prev) => {
          if (prev?.serverName === serverName) {
            abortRef.current?.abort();
            return undefined;
          }
          return prev;
        });
        await onRefreshRef.current();
        if (activeProjectIdRef.current !== activeProjectId) return;
        showToast(`已清除「${serverName}」的 OAuth 凭据`);
      } catch (err) {
        if (activeProjectIdRef.current === activeProjectId) {
          onErrorRef.current(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (activeProjectIdRef.current === activeProjectId) {
          setOauthMutatingServers((prev) => {
            const copy = { ...prev };
            delete copy[serverName];
            return copy;
          });
        }
      }
    },
    [projectId],
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
