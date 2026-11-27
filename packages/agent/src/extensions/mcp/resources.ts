import type { Context } from "@earendil-works/chord/context";
import {
  defineTool,
  type JsonObject,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type LlmContent,
  limitMcpContent,
  type McpOutputSaver,
  type McpRequestOptions,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
} from "@earendil-works/pi-mcp";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { withToolPromptMeta } from "../../context/tool-meta.ts";
import { errorMessage } from "../../shared/guards.ts";
import { formatSize } from "../../shared/truncate.ts";
import { resourceContentToLlm } from "./content.ts";

export const LIST_MCP_RESOURCES_TOOL_NAME = "list_mcp_resources";
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL_NAME = "list_mcp_resource_templates";
export const READ_MCP_RESOURCE_TOOL_NAME = "read_mcp_resource";

export type McpResourceServerInfo = {
  readonly name: string;
  readonly namespace: string;
  readonly extensionName: string;
  readonly hasResources: boolean;
  readonly status: string;
};

export type McpResourceHost = {
  listResourceServers(): readonly McpResourceServerInfo[];
  listResources(server: string, options?: McpRequestOptions): Promise<Resource[]>;
  listResourcesPage(
    server: string,
    cursor?: string,
    options?: McpRequestOptions,
  ): Promise<ListResourcesResult>;
  listResourceTemplates(server: string, options?: McpRequestOptions): Promise<ResourceTemplate[]>;
  listResourceTemplatesPage(
    server: string,
    cursor?: string,
    options?: McpRequestOptions,
  ): Promise<ListResourceTemplatesResult>;
  readResource(
    server: string,
    uri: string,
    options?: McpRequestOptions,
  ): Promise<ReadResourceResult>;
};

export type McpResourceToolDetails = {
  readonly server?: string;
  readonly uri?: string;
  readonly count?: number;
  readonly nextCursor?: string;
  readonly savedPaths?: string[];
  readonly fullOutputPath?: string;
};

export type CreateMcpResourceToolsOptions = {
  readonly host: McpResourceHost;
  readonly saveOutput?: McpOutputSaver;
  readonly timeoutMs?: number;
};

export function isMcpUiResource(resource: {
  readonly uri?: string;
  readonly mimeType?: string;
}): boolean {
  if (resource.uri?.trim().toLowerCase().startsWith("ui://")) return true;
  return resource.mimeType !== undefined && /(?:^|;\s*)profile=mcp-app\b/i.test(resource.mimeType);
}

type ToolAgentApi = Pick<ToolExecutionApi<McpResourceToolDetails>, "agent"> | undefined;

async function resolveAccessibleServers(
  host: McpResourceHost,
  api: ToolAgentApi,
  context: Context,
): Promise<readonly McpResourceServerInfo[]> {
  const all = host.listResourceServers();
  if (typeof api?.agent !== "function") return all;
  const agent = await api.agent(context);
  const active = new Set(agent.extensions.map((ext) => ext.name));
  return all.filter((server) => active.has(server.extensionName));
}

function findServer(
  accessible: readonly McpResourceServerInfo[],
  query: string,
): McpResourceServerInfo | undefined {
  return accessible.find((server) => server.name === query || server.namespace === query);
}

function createListParams(toolName: string) {
  return obj(
    {
      server: opt(
        str({
          description:
            "MCP server name or namespace (e.g. docs or mcp__docs). Omit to list across all accessible servers.",
        }),
      ),
      cursor: opt(
        str({
          description: `Pagination cursor from a previous ${toolName} call (requires server).`,
        }),
      ),
    },
    { open: true },
  );
}

const readResourceParams = obj(
  {
    server: str({ description: "MCP server name or namespace that hosts the resource." }),
    uri: str({ description: "URI of the MCP resource to read." }),
  },
  { open: true },
);

function createListResultSchema(
  resultKey: "resources" | "resourceTemplates",
  extraProperties: Record<string, unknown>,
  requiredFields: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [resultKey]: {
        type: "array",
        items: {
          type: "object",
          properties: {
            server: { type: "string" },
            namespace: { type: "string" },
            name: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            mimeType: { type: "string" },
            ...extraProperties,
          },
          required: [...requiredFields],
          additionalProperties: true,
        },
      },
      nextCursor: { type: "string" },
    },
    required: [resultKey],
    additionalProperties: true,
  };
}

const READ_RESOURCE_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    server: { type: "string" },
    namespace: { type: "string" },
    uri: { type: "string" },
    contents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          uri: { type: "string" },
          mimeType: { type: "string" },
          text: { type: "string" },
          data: { type: "string" },
          encoding: { type: "string" },
          size: { type: "number" },
          savedPath: { type: "string" },
        },
        required: ["uri"],
        additionalProperties: true,
      },
    },
  },
  required: ["server", "namespace", "uri", "contents"],
  additionalProperties: true,
};

type ListItemMeta = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
};

function tagListItem(
  info: McpResourceServerInfo,
  item: ListItemMeta,
  extra: JsonObject,
): JsonObject {
  const tagged: JsonObject = {
    server: info.name,
    namespace: info.namespace,
    name: item.name,
    ...extra,
  };
  if (item.title !== undefined) tagged.title = item.title;
  if (item.description !== undefined) tagged.description = item.description;
  if (item.mimeType !== undefined) tagged.mimeType = item.mimeType;
  return tagged;
}

function formatListLine(
  serverName: string,
  address: string,
  item: ListItemMeta,
  size?: number,
): string {
  const label = item.title ?? item.name;
  const meta = [item.mimeType, size === undefined ? undefined : formatSize(size)].filter(
    (part): part is string => part !== undefined,
  );
  const metaSuffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
  const desc = item.description ? `: ${item.description}` : "";
  return `- [${serverName}] ${address} — ${label}${metaSuffix}${desc}`;
}

function formatListText(
  lines: string[],
  noun: string,
  nextCursor: string | undefined,
  notes: readonly string[],
): string {
  if (lines.length === 0 && notes.length === 0) {
    return nextCursor === undefined
      ? `No ${noun} found.`
      : `No ${noun} on this page. nextCursor: ${nextCursor}`;
  }
  const output = [...lines];
  if (nextCursor !== undefined) output.push(`More results available. nextCursor: ${nextCursor}`);
  for (const note of notes) output.push(note);
  return output.join("\n");
}

function serversForCrossServerList(accessible: readonly McpResourceServerInfo[]): {
  readonly ready: readonly McpResourceServerInfo[];
  readonly pending: readonly McpResourceServerInfo[];
} {
  const connected = accessible.filter((s) => s.status === "connected" || s.status === "degraded");
  // If any server is already connected, query only ready resource servers so slow siblings never block listing.
  if (connected.length > 0) {
    return {
      ready: connected.filter((s) => s.hasResources),
      pending: accessible.filter((s) => s.status === "connecting"),
    };
  }
  return {
    ready: accessible.filter((s) => s.status === "idle" || s.status === "connecting"),
    pending: [],
  };
}

function errorResult(
  text: string,
  details: McpResourceToolDetails = {},
): ToolExecutionResult<McpResourceToolDetails> {
  return { output: [{ type: "text", text }], details, isError: true };
}

type ListToolSpec<TItem> = {
  readonly toolName: string;
  readonly description: string;
  readonly resultKey: "resources" | "resourceTemplates";
  readonly noun: string;
  readonly promptSnippet: string;
  readonly promptGuidelines?: string[];
  readonly extraProperties: Record<string, unknown>;
  readonly requiredFields: readonly string[];
  readonly isUiItem: (item: TItem) => boolean;
  readonly toJson: (info: McpResourceServerInfo, item: TItem) => JsonObject;
  readonly formatLine: (serverName: string, item: TItem) => string;
  readonly fetchPage: (
    host: McpResourceHost,
    server: string,
    cursor: string | undefined,
    options: McpRequestOptions,
  ) => Promise<{ readonly items: readonly TItem[]; readonly nextCursor?: string }>;
  readonly fetchAll: (
    host: McpResourceHost,
    server: string,
    options: McpRequestOptions,
  ) => Promise<readonly TItem[]>;
};

function createMcpListTool<TItem>(
  options: CreateMcpResourceToolsOptions,
  spec: ListToolSpec<TItem>,
): ToolRegistration {
  const { host, saveOutput, timeoutMs } = options;

  return withToolPromptMeta(
    defineTool({
      name: spec.toolName,
      description: spec.description,
      parameters: createListParams(spec.toolName),
      structuredOutputSchema: createListResultSchema(
        spec.resultKey,
        spec.extraProperties,
        spec.requiredFields,
      ),
      replay: "safe",
      execute: async (
        { server, cursor },
        api,
        context,
      ): Promise<ToolExecutionResult<McpResourceToolDetails>> => {
        try {
          const accessible = await resolveAccessibleServers(host, api, context);
          const reqOptions: McpRequestOptions = {
            signal: context.abortSignal,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          };

          if (server !== undefined) {
            const target = findServer(accessible, server);
            if (target === undefined) {
              return errorResult(`MCP server "${server}" is not available in this conversation.`, {
                server,
              });
            }
            const page = await spec.fetchPage(host, target.name, cursor, reqOptions);
            const visible = page.items.filter((item) => !spec.isUiItem(item));
            const items = visible.map((item) => spec.toJson(target, item));
            const lines = visible.map((item) => spec.formatLine(target.name, item));
            const text = formatListText(lines, spec.noun, page.nextCursor, []);
            const limited = await limitMcpContent([{ type: "text", text }], saveOutput);
            const structuredOutput: JsonObject = { [spec.resultKey]: items };
            if (page.nextCursor !== undefined) structuredOutput.nextCursor = page.nextCursor;
            return {
              output: limited.content,
              details: {
                server: target.name,
                count: items.length,
                ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
                ...(limited.fullOutputPath === undefined
                  ? {}
                  : { fullOutputPath: limited.fullOutputPath }),
              },
              structuredOutput,
            };
          }

          if (cursor !== undefined) {
            return errorResult(`Specify server when passing cursor to ${spec.toolName}.`);
          }

          const { ready, pending } = serversForCrossServerList(accessible);
          const items: JsonObject[] = [];
          const lines: string[] = [];
          const notes: string[] = [];
          const settled = await Promise.allSettled(
            ready.map((target) => spec.fetchAll(host, target.name, reqOptions)),
          );
          for (let i = 0; i < settled.length; i += 1) {
            const result = settled[i];
            const target = ready[i];
            if (!result || !target) continue;
            if (result.status === "fulfilled") {
              for (const item of result.value) {
                if (!spec.isUiItem(item)) {
                  items.push(spec.toJson(target, item));
                  lines.push(spec.formatLine(target.name, item));
                }
              }
            } else {
              notes.push(`- [${target.name}] unavailable: ${errorMessage(result.reason)}`);
            }
          }
          if (pending.length > 0) {
            notes.push(
              `Still connecting: ${pending.map((s) => s.name).join(", ")}. Specify server to wait on a specific server.`,
            );
          }

          const text = formatListText(lines, spec.noun, undefined, notes);
          const limited = await limitMcpContent([{ type: "text", text }], saveOutput);
          return {
            output: limited.content,
            details: {
              count: items.length,
              ...(limited.fullOutputPath === undefined
                ? {}
                : { fullOutputPath: limited.fullOutputPath }),
            },
            structuredOutput: { [spec.resultKey]: items },
          };
        } catch (error) {
          return errorResult(
            `Failed to list ${spec.noun}: ${errorMessage(error)}`,
            server === undefined ? {} : { server },
          );
        }
      },
    }),
    {
      promptSnippet: spec.promptSnippet,
      ...(spec.promptGuidelines === undefined ? {} : { promptGuidelines: spec.promptGuidelines }),
    },
  );
}

export function createMcpResourceTools(options: CreateMcpResourceToolsOptions): ToolRegistration[] {
  const { host, saveOutput, timeoutMs } = options;

  const listResourcesTool = createMcpListTool<Resource>(options, {
    toolName: LIST_MCP_RESOURCES_TOOL_NAME,
    description:
      "List available resources exposed by connected MCP servers. Optionally filter by server and paginate with cursor.",
    resultKey: "resources",
    noun: "MCP resources",
    promptSnippet: "List available MCP resources from connected servers",
    promptGuidelines: [
      "Use list_mcp_resources and read_mcp_resource to inspect server-exposed documents, schemas, and data before guessing URIs.",
    ],
    extraProperties: { uri: { type: "string" }, size: { type: "number" } },
    requiredFields: ["server", "namespace", "uri", "name"],
    isUiItem: (item) => isMcpUiResource(item),
    toJson: (info, item) =>
      tagListItem(info, item, {
        uri: item.uri,
        ...(item.size === undefined ? {} : { size: item.size }),
      }),
    formatLine: (serverName, item) => formatListLine(serverName, item.uri, item, item.size),
    fetchPage: async (h, server, cursor, reqOptions) => {
      const page = await h.listResourcesPage(server, cursor, reqOptions);
      return { items: page.resources, nextCursor: page.nextCursor };
    },
    fetchAll: (h, server, reqOptions) => h.listResources(server, reqOptions),
  });

  const listTemplatesTool = createMcpListTool<ResourceTemplate>(options, {
    toolName: LIST_MCP_RESOURCE_TEMPLATES_TOOL_NAME,
    description:
      "List parameterized URI templates for resources exposed by connected MCP servers. Optionally filter by server and paginate with cursor.",
    resultKey: "resourceTemplates",
    noun: "MCP resource templates",
    promptSnippet: "List parameterized MCP resource URI templates",
    extraProperties: { uriTemplate: { type: "string" } },
    requiredFields: ["server", "namespace", "uriTemplate", "name"],
    isUiItem: (item) => isMcpUiResource({ uri: item.uriTemplate, mimeType: item.mimeType }),
    toJson: (info, item) => tagListItem(info, item, { uriTemplate: item.uriTemplate }),
    formatLine: (serverName, item) => formatListLine(serverName, item.uriTemplate, item),
    fetchPage: async (h, server, cursor, reqOptions) => {
      const page = await h.listResourceTemplatesPage(server, cursor, reqOptions);
      return { items: page.resourceTemplates, nextCursor: page.nextCursor };
    },
    fetchAll: (h, server, reqOptions) => h.listResourceTemplates(server, reqOptions),
  });

  const readResourceTool = withToolPromptMeta(
    defineTool({
      name: READ_MCP_RESOURCE_TOOL_NAME,
      description: "Read the contents of an MCP resource from a specific server by URI.",
      parameters: readResourceParams,
      structuredOutputSchema: READ_RESOURCE_RESULT_SCHEMA,
      replay: "safe",
      execute: async (
        { server, uri },
        api,
        context,
      ): Promise<ToolExecutionResult<McpResourceToolDetails>> => {
        try {
          const accessible = await resolveAccessibleServers(host, api, context);
          const target = findServer(accessible, server);
          if (target === undefined) {
            return errorResult(`MCP server "${server}" is not available in this conversation.`, {
              server,
              uri,
            });
          }
          if (isMcpUiResource({ uri })) {
            return errorResult(
              `MCP App UI resource "${uri}" is not accessible via read_mcp_resource.`,
              { server: target.name, uri },
            );
          }

          const reqOptions: McpRequestOptions = {
            signal: context.abortSignal,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          };
          const result = await host.readResource(target.name, uri, reqOptions);
          const filtered = result.contents.filter((item) => !isMcpUiResource(item));
          if (result.contents.length > 0 && filtered.length === 0) {
            return errorResult(
              `MCP App UI resource "${uri}" is not accessible via read_mcp_resource.`,
              { server: target.name, uri },
            );
          }

          const modelBlocks: LlmContent[] = [];
          const structuredContents: JsonObject[] = [];
          const savedPaths: string[] = [];
          for (const item of filtered) {
            const converted = await resourceContentToLlm(item, { saveOutput });
            modelBlocks.push(converted.modelBlock);
            structuredContents.push(converted.structured);
            if (converted.savedPath !== undefined) savedPaths.push(converted.savedPath);
          }

          const limited = await limitMcpContent(modelBlocks, saveOutput);
          const output: LlmContent[] =
            limited.content.length > 0
              ? limited.content
              : [{ type: "text", text: `(empty resource ${uri})` }];

          return {
            output,
            details: {
              server: target.name,
              uri,
              ...(savedPaths.length > 0 ? { savedPaths } : {}),
              ...(limited.fullOutputPath === undefined
                ? {}
                : { fullOutputPath: limited.fullOutputPath }),
            },
            structuredOutput: {
              server: target.name,
              namespace: target.namespace,
              uri,
              contents: structuredContents,
            },
          };
        } catch (error) {
          return errorResult(
            `Failed to read MCP resource ${uri} from ${server}: ${errorMessage(error)}`,
            { server, uri },
          );
        }
      },
    }),
    { promptSnippet: "Read an MCP resource by server and URI" },
  );

  return [listResourcesTool, listTemplatesTool, readResourceTool];
}
