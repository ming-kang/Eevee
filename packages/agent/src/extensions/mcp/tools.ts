import { copyJson } from "@earendil-works/chord/json";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import {
  type CallToolResult,
  type ContentBlock,
  createMcpToolName,
  type LlmContent,
  limitMcpContent,
  type McpOutputSaver,
  type McpRequestOptions,
  type Tool as McpTool,
  normalizeMcpInputSchema,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import { errorMessage, isRecord } from "../../shared/guards.ts";
import { formatSize } from "../../shared/truncate.ts";
import { getMcpToolExposure, type McpServerConfig } from "./config.ts";
import { resourceContentToLlm } from "./content.ts";

export type McpToolDetails = {
  readonly server: string;
  readonly tool: string;
  readonly fullOutputPath?: string;
};

const CONTENT_BLOCK_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
    text: { type: "string" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
};

const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

function relocateSchema(schema: unknown, pointer: string): unknown {
  if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
  if (!isRecord(schema)) return schema;
  const relocated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
      relocated[key] = `${pointer}${value.slice(1)}`;
    } else if (SCHEMA_DATA_KEYWORDS.has(key)) {
      relocated[key] = value;
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      relocated[key] = Object.fromEntries(
        Object.entries(value).map(([name, subschema]) => [
          name,
          relocateSchema(subschema, pointer),
        ]),
      );
    } else {
      relocated[key] = relocateSchema(value, pointer);
    }
  }
  return relocated;
}

export function createMcpResultSchema(
  structuredContentSchema?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
      structuredContent: structuredContentSchema
        ? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
        : {},
      isError: { type: "boolean" },
    },
    required: ["content"],
    additionalProperties: true,
  };
}

function textOf(content: readonly LlmContent[]): string {
  return content
    .filter((block): block is Extract<LlmContent, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function blockToContent(
  block: ContentBlock,
  saveOutput: McpOutputSaver | undefined,
): Promise<LlmContent[]> {
  if (block.type === "resource_link") {
    const details = [
      block.mimeType,
      block.size === undefined ? undefined : formatSize(block.size),
    ].filter((detail) => detail !== undefined);
    const description = block.description === undefined ? "" : `: ${block.description}`;
    return [
      {
        type: "text",
        text: `[Resource ${block.uri} "${block.title ?? block.name}"${
          details.length > 0 ? ` (${details.join(", ")})` : ""
        }${description}]`,
      },
    ];
  }

  if (block.type === "resource") {
    const converted = await resourceContentToLlm(block.resource, {
      saveOutput,
      defaultBinaryMimeType: "unknown type",
      catchSaveError: true,
    });
    return [converted.modelBlock];
  }

  return toLlmContent({ content: [block] });
}

async function toModelContent(
  blocks: readonly ContentBlock[],
  saveOutput?: McpOutputSaver,
): Promise<LlmContent[]> {
  return (await Promise.all(blocks.map((block) => blockToContent(block, saveOutput)))).flat();
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
  const converted =
    result.content.length > 0
      ? await toModelContent(result.content, options.saveOutput)
      : toLlmContent(result);
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
