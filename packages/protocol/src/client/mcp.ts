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

export class ScopedMcpClient<
  TState extends McpStateResponse | ProjectMcpStateResponse =
    | McpStateResponse
    | ProjectMcpStateResponse,
> {
  readonly #transport: HttpTransport;
  readonly #stateSchema: Schema<TState>;
  readonly #prefix: string;

  constructor(transport: HttpTransport, stateSchema: Schema<TState>, projectId?: string) {
    this.#transport = transport;
    this.#stateSchema = stateSchema;
    this.#prefix =
      projectId === undefined ? "/mcp" : `/projects/${encodeURIComponent(projectId)}/mcp`;
  }

  getState(signal?: AbortSignal): Promise<TState> {
    return this.#transport.get(this.#prefix, this.#stateSchema, signal);
  }

  putConfig(input: PutMcpConfigRequest, signal?: AbortSignal): Promise<TState> {
    return this.#transport.put(this.#prefix, this.#stateSchema, input, signal);
  }

  upsertServer(
    serverName: string,
    input: UpsertMcpServerRequest,
    signal?: AbortSignal,
  ): Promise<TState> {
    return this.#transport.put(
      `${this.#prefix}/servers/${encodeURIComponent(serverName)}`,
      this.#stateSchema,
      input,
      signal,
    );
  }

  deleteServer(serverName: string, signal?: AbortSignal): Promise<TState> {
    return this.#transport.del(
      `${this.#prefix}/servers/${encodeURIComponent(serverName)}`,
      this.#stateSchema,
      signal,
    );
  }

  reconnect(input: ReconnectMcpRequest = {}, signal?: AbortSignal): Promise<ReconnectMcpResponse> {
    return this.#transport.post(
      `${this.#prefix}/reconnect`,
      ReconnectMcpResponseSchema,
      input,
      signal,
    );
  }

  getLogs(serverName: string, signal?: AbortSignal): Promise<McpLogsResponse> {
    return this.#transport.get(
      `${this.#prefix}/servers/${encodeURIComponent(serverName)}/logs`,
      McpLogsResponseSchema,
      signal,
    );
  }

  startOAuth(serverName: string, signal?: AbortSignal): Promise<StartMcpOAuthResponse> {
    return this.#transport.post(
      `${this.#prefix}/servers/${encodeURIComponent(serverName)}/oauth/login`,
      StartMcpOAuthResponseSchema,
      undefined,
      signal,
    );
  }

  async *streamOAuth(
    serverName: string,
    sessionId: string,
    opts?: StreamMcpOAuthOptions,
  ): AsyncGenerator<McpOAuthEvent> {
    const path = `${this.#prefix}/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/stream`;
    for await (const sse of this.#transport.streamSse(path, opts?.signal)) {
      if (
        sse.event === "auth_url" ||
        sse.event === "progress" ||
        sse.event === "complete" ||
        sse.event === "error" ||
        sse.event === "message"
      ) {
        const event = this.#transport.decodeSseEvent(
          sse,
          McpOAuthEventSchema,
          "MCP OAuth SSE payload",
        );
        yield event;
        if (event.type === "complete" || event.type === "error") return;
      }
    }
  }

  submitOAuthInput(
    serverName: string,
    sessionId: string,
    input: McpOAuthInputRequest,
    signal?: AbortSignal,
  ): Promise<OkResponse> {
    return this.#transport.post(
      `${this.#prefix}/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/input`,
      OkResponseSchema,
      input,
      signal,
    );
  }

  cancelOAuth(serverName: string, sessionId: string, signal?: AbortSignal): Promise<OkResponse> {
    return this.#transport.post(
      `${this.#prefix}/servers/${encodeURIComponent(serverName)}/oauth/login/${encodeURIComponent(sessionId)}/cancel`,
      OkResponseSchema,
      undefined,
      signal,
    );
  }

  logoutOAuth(serverName: string, signal?: AbortSignal): Promise<OkResponse> {
    return this.#transport.del(
      `${this.#prefix}/servers/${encodeURIComponent(serverName)}/oauth`,
      OkResponseSchema,
      signal,
    );
  }
}
