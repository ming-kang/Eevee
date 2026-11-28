import { copyJson } from "@earendil-works/chord/json";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import {
  type CallToolResult,
  createMcpResultSchema,
  createMcpToolName,
  type LlmContent,
  limitMcpContent,
  type McpOutputSaver,
  type McpRequestOptions,
  type Tool as McpTool,
  normalizeMcpInputSchema,
  toMcpModelContent,
} from "@earendil-works/pi-mcp";
import { errorMessage, isRecord } from "../../shared/guards.ts";
import { getMcpToolExposure, type McpServerConfig } from "./config.ts";
import { READ_MCP_RESOURCE_TOOL_NAME } from "./resources.ts";

export { createMcpResultSchema };

export type McpToolDetails = {
  readonly server: string;
  readonly tool: string;
  readonly fullOutputPath?: string;
};

function textOf(content: readonly LlmContent[]): string {
  return content
    .filter((block): block is Extract<LlmContent, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export type ConvertMcpResultOptions = {
  readonly saveOutput?: McpOutputSaver;
};

export async function convertMcpResult(
  server: string,
  tool: string,
  result: CallToolResult,
  options: ConvertMcpResultOptions = {},
): Promise<ToolExecutionResult<McpToolDetails>> {
  const converted = await toMcpModelContent(server, result, {
    ...(options.saveOutput === undefined ? {} : { saveOutput: options.saveOutput }),
    readResourceTool: READ_MCP_RESOURCE_TOOL_NAME,
  });
  if (result.isError === true && textOf(converted) === "") {
    converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
  }
  const limited = await limitMcpContent(converted, options.saveOutput);
  const { _meta: _ignored, ...rest } = result;
  return {
    output: limited.content,
    details: {
      server,
      tool,
      ...(limited.fullOutputPath === undefined ? {} : { fullOutputPath: limited.fullOutputPath }),
    },
    structuredOutput: copyJson(rest, { omitUndefinedProperties: true }),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

export type McpToolCaller = (
  name: string,
  args: Record<string, unknown>,
  options: McpRequestOptions,
) => Promise<CallToolResult>;

export type AdaptMcpToolsOptions = {
  readonly server: string;
  readonly tools: readonly McpTool[];
  readonly config: McpServerConfig;
  readonly timeoutMs: number;
  readonly callTool: McpToolCaller;
  readonly saveOutput?: McpOutputSaver;
};

export function adaptMcpTools(options: AdaptMcpToolsOptions): ToolRegistration[] {
  const { server, config } = options;
  const taken = new Set<string>();
  const registrations: ToolRegistration[] = [];

  for (const tool of options.tools) {
    const exposure = getMcpToolExposure(config, tool.name);
    if (exposure === "hidden") continue;
    const name = createMcpToolName(server, tool.name, (candidate) => taken.has(candidate));
    taken.add(name);
    const title = tool.title ?? tool.annotations?.title;
    registrations.push({
      name,
      description:
        tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
      parameters: normalizeMcpInputSchema(tool.inputSchema),
      structuredOutputSchema: createMcpResultSchema(tool.outputSchema),
      ...(exposure === "deferred" || exposure === "codemode" ? { deferred: true as const } : {}),
      ...(exposure === "codemode" ? { callers: ["tools" as const] } : {}),
      replay: tool.annotations?.readOnlyHint === true ? "safe" : "unsafe",
      execute: async (args, _api, context): Promise<ToolExecutionResult<McpToolDetails>> => {
        try {
          const result = await options.callTool(tool.name, isRecord(args) ? args : {}, {
            signal: context.abortSignal,
            timeoutMs: options.timeoutMs,
          });
          return await convertMcpResult(server, tool.name, result, {
            saveOutput: options.saveOutput,
          });
        } catch (error) {
          return {
            output: [
              {
                type: "text",
                text: `MCP tool ${server}/${tool.name} failed: ${errorMessage(error)}`,
              },
            ],
            details: { server, tool: tool.name },
            isError: true,
          };
        }
      },
    });
  }

  return registrations;
}
