import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  type CallToolResult,
  createMcpToolName,
  limitMcpContent,
  type McpOutputSaver,
  type McpRequestOptions,
  type Tool as McpTool,
  normalizeMcpInputSchema,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import type { McpExposure } from "./config.ts";

export type McpCaller = {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<CallToolResult>;
};

export type BridgeOptions = {
  exposure: McpExposure;
  timeoutMs?: number;
  /** Keeps the full text of an output cut to fit the model; returns a path `read` can open. */
  saveOutput?: McpOutputSaver;
};

/**
 * The server's tools as Durable tools named `mcp__<server>__<tool>`: deferred ones wait for `tool_search`,
 * code mode ones are callable from scripts only. Long text keeps its start and end.
 */
export function bridgeTools(
  server: string,
  client: McpCaller,
  tools: readonly McpTool[],
  options: BridgeOptions,
): ToolRegistration[] {
  if (options.exposure === "hidden") return [];
  const taken = new Set<string>();
  return tools.map((tool) => {
    const name = createMcpToolName(server, tool.name, (candidate) => taken.has(candidate));
    taken.add(name);
    return defineTool({
      name,
      description: tool.description ?? tool.title ?? tool.name,
      parameters: normalizeMcpInputSchema(tool.inputSchema),
      ...(options.exposure === "deferred" ? { deferred: true as const } : {}),
      ...(options.exposure === "codemode" ? { callers: ["tools"] as const } : {}),
      replay: "unsafe",
      async execute(args, _api, context) {
        const result = await client.callTool(tool.name, (args ?? {}) as Record<string, unknown>, {
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        const limited = await limitMcpContent(toLlmContent(result), options.saveOutput);
        return { output: limited.content, ...(result.isError === true ? { isError: true } : {}) };
      },
    }) as ToolRegistration;
  });
}
