import {
  type McpLogsResponse,
  type McpServerSnapshotPayload,
  PutGlobalMcpConfigRequestSchema,
  PutMcpConfigRequestSchema,
  parseWithSchema,
  UpsertGlobalMcpServerRequestSchema,
  UpsertMcpServerRequestSchema,
} from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { useAbortableAsync } from "../../../lib/useAbortableAsync.ts";
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

  const { run: runLoad } = useAbortableAsync();
  const activeClientRef = useRef(client);
  activeClientRef.current = client;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await runLoad((signal) => client.getState(signal));
      if (!res || activeClientRef.current !== client) return;
      setState(normalizeMcpState(res));
      setLoading(false);
    } catch (err) {
      if (activeClientRef.current === client) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
  }, [client, runLoad]);

  useEffect(() => {
    setState(normalizeMcpState(undefined));
    void reload();
  }, [reload]);

  const upsertServer = useCallback(
    async (serverName: string, config: Record<string, unknown>) => {
      const input = parseWithSchema(
        projectId === undefined ? UpsertGlobalMcpServerRequestSchema : UpsertMcpServerRequestSchema,
        { config },
        "MCP server config",
      );
      const next = await client.upsertServer(serverName, input);
      if (activeClientRef.current === client) {
        setState(normalizeMcpState(next));
      }
    },
    [client, projectId],
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
      const input = parseWithSchema(
        projectId === undefined ? PutGlobalMcpConfigRequestSchema : PutMcpConfigRequestSchema,
        { servers },
        "MCP config",
      );
      const next = await client.putConfig(input);
      if (activeClientRef.current === client) {
        setState(normalizeMcpState(next));
      }
    },
    [client, projectId],
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
