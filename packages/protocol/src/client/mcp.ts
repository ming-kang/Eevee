import type { Schema } from "@earendil-works/pi-schema";
import { type OkResponse, OkResponseSchema } from "../schemas/common.ts";
import {
  type McpLogsResponse,
  McpLogsResponseSchema,
  type McpOAuthEvent,
  McpOAuthEventSchema,
  type McpOAuthInputRequest,
  type McpStateResponse,
  type ProjectMcpStateResponse,
  type PutMcpConfigRequest,
  type ReconnectMcpRequest,
  type ReconnectMcpResponse,
  ReconnectMcpResponseSchema,
  type StartMcpOAuthResponse,
  StartMcpOAuthResponseSchema,
  type UpsertMcpServerRequest,
} from "../schemas/mcp.ts";
import type { HttpTransport } from "./transport.ts";

export type StreamMcpOAuthOptions = {
  readonly signal?: AbortSignal;
};

export type ScopedMcpClient<
  TState extends McpStateResponse | ProjectMcpStateResponse =
    | McpStateResponse
    | ProjectMcpStateResponse,
> = {
  getState(signal?: AbortSignal): Promise<TState>;
  putConfig(input: PutMcpConfigRequest, signal?: AbortSignal): Promise<TState>;
  upsertServer(
    serverName: string,
    input: UpsertMcpServerRequest,
    signal?: AbortSignal,
  ): Promise<TState>;
  deleteServer(serverName: string, signal?: AbortSignal): Promise<TState>;
  reconnect(input?: ReconnectMcpRequest, signal?: AbortSignal): Promise<ReconnectMcpResponse>;
  getLogs(serverName: string, signal?: AbortSignal): Promise<McpLogsResponse>;
  startOAuth(serverName: string, signal?: AbortSignal): Promise<StartMcpOAuthResponse>;
  streamOAuth(
    serverName: string,
    sessionId: string,
    opts?: StreamMcpOAuthOptions,
  ): AsyncGenerator<McpOAuthEvent>;
  submitOAuthInput(
    serverName: string,
    sessionId: string,
    input: McpOAuthInputRequest,
    signal?: AbortSignal,
  ): Promise<OkResponse>;
  cancelOAuth(serverName: string, sessionId: string, signal?: AbortSignal): Promise<OkResponse>;
  logoutOAuth(serverName: string, signal?: AbortSignal): Promise<OkResponse>;
};

export function createScopedMcpClient<
  TState extends McpStateResponse | ProjectMcpStateResponse =
    | McpStateResponse
    | ProjectMcpStateResponse,
>(
  transport: HttpTransport,
  stateSchema: Schema<TState>,
  projectId?: string,
): ScopedMcpClient<TState> {
  const prefix =
    projectId === undefined ? "/mcp" : `/projects/${encodeURIComponent(projectId)}/mcp`;
  return {
    getState(signal?: AbortSignal): Promise<TState> {
      return transport.get(prefix, stateSchema, signal);
    },

    putConfig(input: PutMcpConfigRequest, signal?: AbortSignal): Promise<TState> {
      return transport.put(prefix, stateSchema, input, signal);
    },

    upsertServer(
      serverName: string,
      input: UpsertMcpServerRequest,
      signal?: AbortSignal,
    ): Promise<TState> {
      return transport.put(
        `${prefix}/servers/${encodeURIComponent(serverName)}`,
        stateSchema,
        input,
        signal,
      );
    },

    deleteServer(serverName: string, signal?: AbortSignal): Promise<TState> {
      return transport.del(
        `${prefix}/servers/${encodeURIComponent(serverName)}`,
        stateSchema,
        signal,
      );
    },

    reconnect(
      input: ReconnectMcpRequest = {},
      signal?: AbortSignal,
    ): Promise<ReconnectMcpResponse> {
      return transport.post(`${prefix}/reconnect`, ReconnectMcpResponseSchema, input, signal);
    },

    getLogs(serverName: string, signal?: AbortSignal): Promise<McpLogsResponse> {
      return transport.get(
        `${prefix}/servers/${encodeURIComponent(serverName)}/logs`,
        McpLogsResponseSchema,
        signal,
      );
    },

    startOAuth(serverName: string, signal?: AbortSignal): Promise<StartMcpOAuthResponse> {
      return transport.post(
        `${prefix}/servers/${encodeURIComponent(serverName)}/oauth/login`,
        StartMcpOAuthResponseSchema,
        undefined,
        signal,
      );
    },

    streamOAuth(
      serverName: string,
      sessionId: string,
      opts?: StreamMcpOAuthOptions,
    ): AsyncGenerator<McpOAuthEvent> {
      const path = `${prefix}/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/stream`;
      return transport.streamDecodedSse<McpOAuthEvent>(
        path,
        {
          signal: opts?.signal,
          isTerminal: (event) => event.type === "complete" || event.type === "error",
        },
        (sse) => {
          if (
            sse.event === "auth_url" ||
            sse.event === "progress" ||
            sse.event === "complete" ||
            sse.event === "error" ||
            sse.event === "message"
          ) {
            return transport.decodeSseEvent(sse, McpOAuthEventSchema, "MCP OAuth SSE payload");
          }
          return undefined;
        },
      );
    },

    submitOAuthInput(
      serverName: string,
      sessionId: string,
      input: McpOAuthInputRequest,
      signal?: AbortSignal,
    ): Promise<OkResponse> {
      return transport.post(
        `${prefix}/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/input`,
        OkResponseSchema,
        input,
        signal,
      );
    },

    cancelOAuth(serverName: string, sessionId: string, signal?: AbortSignal): Promise<OkResponse> {
      return transport.post(
        `${prefix}/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/cancel`,
        OkResponseSchema,
        undefined,
        signal,
      );
    },

    logoutOAuth(serverName: string, signal?: AbortSignal): Promise<OkResponse> {
      return transport.del(
        `${prefix}/servers/${encodeURIComponent(serverName)}/oauth`,
        OkResponseSchema,
        signal,
      );
    },
  };
}
