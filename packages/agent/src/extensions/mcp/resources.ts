import type { JsonValue } from "@earendil-works/chord/json";
import {
  defineTool,
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
  if (resource.uri?.trim().toLowerCase().startsWith("ui://")) {
    return true;
  }
  if (resource.mimeType !== undefined && /(?:^|;\s*)profile=mcp-app\b/i.test(resource.mimeType)) {
    return true;
  }
  return false;
}

function extensionOf(uri: string): string {
  const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
  return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

function isTextMimeType(mimeType: string | undefined): boolean {
  if (mimeType === undefined) return false;
  const type = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

async function resolveAccessibleServers(
  host: McpResourceHost,
  api: {
    agent?: (
      context: never,
    ) => Promise<{ readonly extensions: readonly { readonly name: string }[] }>;
  },
  context: unknown,
): Promise<readonly McpResourceServerInfo[]> {
  const all = host.listResourceServers();
  if (typeof api?.agent !== "function") return all;
  const agent = await api.agent(context as never);
  const active = new Set(agent.extensions.map((ext) => ext.name));
  return all.filter((server) => active.has(server.extensionName));
}

function findServer(
  accessible: readonly McpResourceServerInfo[],
  query: string,
): McpResourceServerInfo | undefined {
  return accessible.find((server) => server.name === query || server.namespace === query);
}

const listResourcesParams = obj(
  {
    server: opt(
      str({
        description:
          "MCP server name or namespace (e.g. docs or mcp__docs). Omit to list across all accessible servers.",
      }),
    ),
    cursor: opt(
      str({
        description: "Pagination cursor from a previous list_mcp_resources call (requires server).",
      }),
    ),
  },
  { open: true },
);

const listTemplatesParams = obj(
  {
    server: opt(
      str({
        description:
          "MCP server name or namespace (e.g. docs or mcp__docs). Omit to list across all accessible servers.",
      }),
    ),
    cursor: opt(
      str({
        description:
          "Pagination cursor from a previous list_mcp_resource_templates call (requires server).",
      }),
    ),
  },
  { open: true },
);

const readResourceParams = obj(
  {
    server: str({ description: "MCP server name or namespace that hosts the resource." }),
    uri: str({ description: "URI of the MCP resource to read." }),
  },
  { open: true },
);

const LIST_RESOURCES_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    resources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          server: { type: "string" },
          namespace: { type: "string" },
          uri: { type: "string" },
          name: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          mimeType: { type: "string" },
          size: { type: "number" },
        },
        required: ["server", "namespace", "uri", "name"],
        additionalProperties: true,
      },
    },
    nextCursor: { type: "string" },
  },
  required: ["resources"],
  additionalProperties: true,
};

const LIST_TEMPLATES_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    resourceTemplates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          server: { type: "string" },
          namespace: { type: "string" },
          uriTemplate: { type: "string" },
          name: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          mimeType: { type: "string" },
        },
        required: ["server", "namespace", "uriTemplate", "name"],
        additionalProperties: true,
      },
    },
    nextCursor: { type: "string" },
  },
  required: ["resourceTemplates"],
  additionalProperties: true,
};

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

type TaggedResource = {
  readonly server: string;
  readonly namespace: string;
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
};

type TaggedTemplate = {
  readonly server: string;
  readonly namespace: string;
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
};

function tagResource(info: McpResourceServerInfo, item: Resource): TaggedResource {
  return {
    server: info.name,
    namespace: info.namespace,
    uri: item.uri,
    name: item.name,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
    ...(item.size === undefined ? {} : { size: item.size }),
  };
}

function tagTemplate(info: McpResourceServerInfo, item: ResourceTemplate): TaggedTemplate {
  return {
    server: info.name,
    namespace: info.namespace,
    uriTemplate: item.uriTemplate,
    name: item.name,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
  };
}

function formatResourcesText(
  items: readonly TaggedResource[],
  nextCursor: string | undefined,
  notes: readonly string[],
): string {
  if (items.length === 0 && notes.length === 0) {
    return nextCursor === undefined
      ? "No MCP resources found."
      : `No MCP resources on this page. nextCursor: ${nextCursor}`;
  }
  const lines = items.map((item) => {
    const label = item.title ?? item.name;
    const meta = [
      item.mimeType,
      item.size === undefined ? undefined : formatSize(item.size),
    ].filter((part): part is string => part !== undefined);
    const metaSuffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
    const desc = item.description ? `: ${item.description}` : "";
    return `- [${item.server}] ${item.uri} — ${label}${metaSuffix}${desc}`;
  });
  if (nextCursor !== undefined) {
    lines.push(`More results available. nextCursor: ${nextCursor}`);
  }
  for (const note of notes) lines.push(note);
  return lines.join("\n");
}

function formatTemplatesText(
  items: readonly TaggedTemplate[],
  nextCursor: string | undefined,
  notes: readonly string[],
): string {
  if (items.length === 0 && notes.length === 0) {
    return nextCursor === undefined
      ? "No MCP resource templates found."
      : `No MCP resource templates on this page. nextCursor: ${nextCursor}`;
  }
  const lines = items.map((item) => {
    const label = item.title ?? item.name;
    const meta = item.mimeType ? ` (${item.mimeType})` : "";
    const desc = item.description ? `: ${item.description}` : "";
    return `- [${item.server}] ${item.uriTemplate} — ${label}${meta}${desc}`;
  });
  if (nextCursor !== undefined) {
    lines.push(`More results available. nextCursor: ${nextCursor}`);
  }
  for (const note of notes) lines.push(note);
  return lines.join("\n");
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

export function createMcpResourceTools(options: CreateMcpResourceToolsOptions): ToolRegistration[] {
  const { host, saveOutput, timeoutMs } = options;

  const listResourcesTool = withToolPromptMeta(
    defineTool({
      name: LIST_MCP_RESOURCES_TOOL_NAME,
      description:
        "List available resources exposed by connected MCP servers. Optionally filter by server and paginate with cursor.",
      parameters: listResourcesParams,
      structuredOutputSchema: LIST_RESOURCES_RESULT_SCHEMA,
      replay: "safe",
      execute: async (
        { server, cursor },
        api,
        context,
      ): Promise<ToolExecutionResult<McpResourceToolDetails>> => {
        try {
          const accessible = await resolveAccessibleServers(host, api as never, context);
          const reqOptions: McpRequestOptions = {
            signal: context.abortSignal,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          };

          if (server !== undefined) {
            const target = findServer(accessible, server);
            if (target === undefined) {
              return {
                output: [
                  {
                    type: "text",
                    text: `MCP server "${server}" is not available in this conversation.`,
                  },
                ],
                details: { server },
                isError: true,
              };
            }
            const page = await host.listResourcesPage(target.name, cursor, reqOptions);
            const items = page.resources
              .filter((item) => !isMcpUiResource(item))
              .map((item) => tagResource(target, item));
            const text = formatResourcesText(items, page.nextCursor, []);
            const limited = await limitMcpContent([{ type: "text", text }], saveOutput);
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
              structuredOutput: {
                resources: items,
                ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
              } as unknown as JsonValue,
            };
          }

          if (cursor !== undefined) {
            return {
              output: [
                {
                  type: "text",
                  text: "Specify server when passing cursor to list_mcp_resources.",
                },
              ],
              details: {},
              isError: true,
            };
          }

          const { ready, pending } = serversForCrossServerList(accessible);
          const items: TaggedResource[] = [];
          const notes: string[] = [];
          const settled = await Promise.allSettled(
            ready.map(async (target) => ({
              target,
              resources: await host.listResources(target.name, reqOptions),
            })),
          );
          for (let i = 0; i < settled.length; i += 1) {
            const result = settled[i];
            const target = ready[i];
            if (!result || !target) continue;
            if (result.status === "fulfilled") {
              for (const item of result.value.resources) {
                if (!isMcpUiResource(item)) items.push(tagResource(target, item));
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

          const text = formatResourcesText(items, undefined, notes);
          const limited = await limitMcpContent([{ type: "text", text }], saveOutput);
          return {
            output: limited.content,
            details: {
              count: items.length,
              ...(limited.fullOutputPath === undefined
                ? {}
                : { fullOutputPath: limited.fullOutputPath }),
            },
            structuredOutput: { resources: items } as unknown as JsonValue,
          };
        } catch (error) {
          return {
            output: [
              { type: "text", text: `Failed to list MCP resources: ${errorMessage(error)}` },
            ],
            details: server === undefined ? {} : { server },
            isError: true,
          };
        }
      },
    }),
    {
      promptSnippet: "List available MCP resources from connected servers",
      promptGuidelines: [
        "Use list_mcp_resources and read_mcp_resource to inspect server-exposed documents, schemas, and data before guessing URIs.",
      ],
    },
  );

  const listTemplatesTool = withToolPromptMeta(
    defineTool({
      name: LIST_MCP_RESOURCE_TEMPLATES_TOOL_NAME,
      description:
        "List parameterized URI templates for resources exposed by connected MCP servers. Optionally filter by server and paginate with cursor.",
      parameters: listTemplatesParams,
      structuredOutputSchema: LIST_TEMPLATES_RESULT_SCHEMA,
      replay: "safe",
      execute: async (
        { server, cursor },
        api,
        context,
      ): Promise<ToolExecutionResult<McpResourceToolDetails>> => {
        try {
          const accessible = await resolveAccessibleServers(host, api as never, context);
          const reqOptions: McpRequestOptions = {
            signal: context.abortSignal,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          };

          if (server !== undefined) {
            const target = findServer(accessible, server);
            if (target === undefined) {
              return {
                output: [
                  {
                    type: "text",
                    text: `MCP server "${server}" is not available in this conversation.`,
                  },
                ],
                details: { server },
                isError: true,
              };
            }
            const page = await host.listResourceTemplatesPage(target.name, cursor, reqOptions);
            const items = page.resourceTemplates
              .filter(
                (item) => !isMcpUiResource({ uri: item.uriTemplate, mimeType: item.mimeType }),
              )
              .map((item) => tagTemplate(target, item));
            const text = formatTemplatesText(items, page.nextCursor, []);
            const limited = await limitMcpContent([{ type: "text", text }], saveOutput);
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
              structuredOutput: {
                resourceTemplates: items,
                ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
              } as unknown as JsonValue,
            };
          }

          if (cursor !== undefined) {
            return {
              output: [
                {
                  type: "text",
                  text: "Specify server when passing cursor to list_mcp_resource_templates.",
                },
              ],
              details: {},
              isError: true,
            };
          }

          const { ready, pending } = serversForCrossServerList(accessible);
          const items: TaggedTemplate[] = [];
          const notes: string[] = [];
          const settled = await Promise.allSettled(
            ready.map(async (target) => ({
              target,
              templates: await host.listResourceTemplates(target.name, reqOptions),
            })),
          );
          for (let i = 0; i < settled.length; i += 1) {
            const result = settled[i];
            const target = ready[i];
            if (!result || !target) continue;
            if (result.status === "fulfilled") {
              for (const item of result.value.templates) {
                if (!isMcpUiResource({ uri: item.uriTemplate, mimeType: item.mimeType })) {
                  items.push(tagTemplate(target, item));
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

          const text = formatTemplatesText(items, undefined, notes);
          const limited = await limitMcpContent([{ type: "text", text }], saveOutput);
          return {
            output: limited.content,
            details: {
              count: items.length,
              ...(limited.fullOutputPath === undefined
                ? {}
                : { fullOutputPath: limited.fullOutputPath }),
            },
            structuredOutput: { resourceTemplates: items } as unknown as JsonValue,
          };
        } catch (error) {
          return {
            output: [
              {
                type: "text",
                text: `Failed to list MCP resource templates: ${errorMessage(error)}`,
              },
            ],
            details: server === undefined ? {} : { server },
            isError: true,
          };
        }
      },
    }),
    {
      promptSnippet: "List parameterized MCP resource URI templates",
    },
  );

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
          const accessible = await resolveAccessibleServers(host, api as never, context);
          const target = findServer(accessible, server);
          if (target === undefined) {
            return {
              output: [
                {
                  type: "text",
                  text: `MCP server "${server}" is not available in this conversation.`,
                },
              ],
              details: { server, uri },
              isError: true,
            };
          }
          if (isMcpUiResource({ uri })) {
            return {
              output: [
                {
                  type: "text",
                  text: `MCP App UI resource "${uri}" is not accessible via read_mcp_resource.`,
                },
              ],
              details: { server: target.name, uri },
              isError: true,
            };
          }

          const reqOptions: McpRequestOptions = {
            signal: context.abortSignal,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          };
          const result = await host.readResource(target.name, uri, reqOptions);
          const filtered = result.contents.filter((item) => !isMcpUiResource(item));
          if (result.contents.length > 0 && filtered.length === 0) {
            return {
              output: [
                {
                  type: "text",
                  text: `MCP App UI resource "${uri}" is not accessible via read_mcp_resource.`,
                },
              ],
              details: { server: target.name, uri },
              isError: true,
            };
          }

          const modelBlocks: LlmContent[] = [];
          const structuredContents: Record<string, unknown>[] = [];
          const savedPaths: string[] = [];

          for (const item of filtered) {
            if ("text" in item) {
              modelBlocks.push({ type: "text", text: item.text });
              structuredContents.push({
                uri: item.uri,
                ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
                text: item.text,
              });
              continue;
            }
            if (item.mimeType?.startsWith("image/")) {
              modelBlocks.push({ type: "image", data: item.blob, mimeType: item.mimeType });
              structuredContents.push({
                uri: item.uri,
                mimeType: item.mimeType,
                encoding: "base64",
                data: item.blob,
              });
              continue;
            }
            const data = Buffer.from(item.blob, "base64");
            if (isTextMimeType(item.mimeType)) {
              const text = data.toString("utf8");
              modelBlocks.push({ type: "text", text });
              structuredContents.push({
                uri: item.uri,
                ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
                text,
              });
              continue;
            }
            const kind = `${item.mimeType ?? "application/octet-stream"}, ${formatSize(data.length)}`;
            if (saveOutput === undefined) {
              modelBlocks.push({
                type: "text",
                text: `[Binary resource ${item.uri} (${kind}) omitted]`,
              });
              structuredContents.push({
                uri: item.uri,
                ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
                size: data.length,
              });
              continue;
            }
            const savedPath = await saveOutput(data, extensionOf(item.uri));
            savedPaths.push(savedPath);
            modelBlocks.push({
              type: "text",
              text: `[Binary resource ${item.uri} (${kind}) saved to ${savedPath}]`,
            });
            structuredContents.push({
              uri: item.uri,
              ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
              size: data.length,
              savedPath,
            });
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
            } as unknown as JsonValue,
          };
        } catch (error) {
          return {
            output: [
              {
                type: "text",
                text: `Failed to read MCP resource ${uri} from ${server}: ${errorMessage(error)}`,
              },
            ],
            details: { server, uri },
            isError: true,
          };
        }
      },
    }),
    {
      promptSnippet: "Read an MCP resource by server and URI",
    },
  );

  return [listResourcesTool, listTemplatesTool, readResourceTool];
}
