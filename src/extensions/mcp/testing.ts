import { type JsonRpcMessage, LATEST_PROTOCOL_VERSION, type Tool } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

/**
 * An in-memory MCP server for tests: it offers `tools` and answers every call with the tool's name and arguments.
 * Hand `client` to the code under test; close `server` to drop the connection.
 */
export function fakeMcpServer(tools: Tool[], instructions?: string) {
  const pair = createInMemoryTransportPair();
  pair.server.onMessage((message) => {
    if (!("id" in message) || !("method" in message)) return;
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1.0.0" },
            ...(instructions === undefined ? {} : { instructions }),
          }
        : message.method === "tools/list"
          ? { tools }
          : { content: [{ type: "text", text: describeCall(message.params) }] };
    const response: JsonRpcMessage = { jsonrpc: "2.0", id: message.id, result };
    queueMicrotask(() => void pair.server.send(response));
  });
  void pair.server.start();
  return pair;
}

export type FakeMcpServer = ReturnType<typeof fakeMcpServer>;

function describeCall(params: unknown): string {
  const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: unknown };
  return `${name} ${JSON.stringify(args)}`;
}

export const weatherTool: Tool = {
  name: "get-weather",
  description: "查天气",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
};
