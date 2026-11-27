import type { McpLogsResponse, McpServerSnapshotPayload } from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { type NormalizedMcpState, normalizeMcpState } from "./scope-helpers.ts";

export type UseMcpScopeResult = {
  readonly statuses: readonly McpServerSnapshotPayload[];
  readonly globalServers: Record<string, Record<string, unknown>>;
  readonly projectServers: Record<string, Record<string, unknown>>;
  readonly effectiveServers: Record<string, Record<string, unknown>>;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly setError: (message: string | undefined) => void;
  readonly reload: () => Promise<void>;
  readonly upsertServer: (serverName: string, config: Record<string, unknown>) => Promise<void>;
  readonly deleteServer: (serverName: string) => Promise<void>;
  readonly putConfig: (servers: Record<string, Record<string, unknown>>) => Promise<void>;
  readonly reconnect: (server?: string) => Promise<void>;
  readonly getLogs: (serverName: string) => Promise<McpLogsResponse>;
};

export function useMcpScope(projectId?: string): UseMcpScopeResult {
  const client = useMemo(() => api.mcp(projectId), [projectId]);
  const [state, setState] = useState<NormalizedMcpState>(() => normalizeMcpState(undefined));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const loadAbortRef = useRef<AbortController | undefined>(undefined);
  const activeClientRef = useRef(client);
  activeClientRef.current = client;

  const reload = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const res = await client.getState(controller.signal);
      if (!controller.signal.aborted && activeClientRef.current === client) {
        setState(normalizeMcpState(res));
      }
    } catch (err) {
      if (!controller.signal.aborted && activeClientRef.current === client) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!controller.signal.aborted && activeClientRef.current === client) {
        setLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    setState(normalizeMcpState(undefined));
    void reload();
    return () => {
      loadAbortRef.current?.abort();
    };
  }, [reload]);

  const upsertServer = useCallback(
    async (serverName: string, config: Record<string, unknown>) => {
      const next = await client.upsertServer(serverName, { config });
      if (activeClientRef.current === client) {
        setState(normalizeMcpState(next));
      }
    },
    [client],
  );

  const deleteServer = useCallback(
    async (serverName: string) => {
      const next = await client.deleteServer(serverName);
      if (activeClientRef.current === client) {
        setState(normalizeMcpState(next));
      }
    },
    [client],
  );

  const putConfig = useCallback(
    async (servers: Record<string, Record<string, unknown>>) => {
      const next = await client.putConfig({ servers });
      if (activeClientRef.current === client) {
        setState(normalizeMcpState(next));
      }
    },
    [client],
  );

  const reconnect = useCallback(
    async (server?: string) => {
      await client.reconnect(server ? { server } : {});
      if (activeClientRef.current === client) {
        await reload();
      }
    },
    [client, reload],
  );

  const getLogs = useCallback((serverName: string) => client.getLogs(serverName), [client]);

  return {
    statuses: state.statuses,
    globalServers: state.globalServers,
    projectServers: state.projectServers,
    effectiveServers: state.effectiveServers,
    loading,
    error,
    setError,
    reload,
    upsertServer,
    deleteServer,
    putConfig,
    reconnect,
    getLogs,
  };
}
