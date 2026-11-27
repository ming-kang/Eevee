import {
  defineExtension,
  type Extension,
  type PromptInput,
  type Registry,
} from "@earendil-works/pi-durable";
import {
  type CallToolResult,
  type McpOutputSaver,
  type McpRequestOptions,
  type Tool as McpTool,
  mcpNamespace,
  mcpServerSummary,
} from "@earendil-works/pi-mcp";
import {
  DEFAULT_MCP_EXPOSURE,
  type McpServerEntry,
  type ResolvedMcpServerRoles,
  resolveMcpServerRoles,
} from "./config.ts";
import { createMcpResourceTools, type McpResourceHost } from "./resources.ts";
import type { McpServerStatus } from "./snapshot.ts";
import { adaptMcpTools } from "./tools.ts";

export const MCP_EXTENSION = "eevee.mcp";
export const MCP_SERVER_EXTENSION_PREFIX = "eevee.mcp.";

export type { ResolvedMcpServerRoles };

export function mcpServerExtensionName(server: string): string {
  return `${MCP_SERVER_EXTENSION_PREFIX}${server}`;
}

export type McpServerExtensionEntry = {
  readonly server: string;
  readonly extension: Extension;
  readonly roles: ResolvedMcpServerRoles;
};

const MCP_SERVER_ROLES = Symbol("eevee.mcp.serverRoles");

function attachServerRoles(extension: Extension, roles: ResolvedMcpServerRoles): Extension {
  Object.defineProperty(extension, MCP_SERVER_ROLES, {
    value: roles,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return extension;
}

export function getMcpServerExtensionRoles(
  extension: Extension,
): ResolvedMcpServerRoles | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(extension, MCP_SERVER_ROLES);
  const value: unknown = descriptor?.value;
  if (
    typeof value === "object" &&
    value !== null &&
    "router" in value &&
    typeof value.router === "boolean" &&
    "worker" in value &&
    typeof value.worker === "boolean"
  ) {
    return { router: value.router, worker: value.worker };
  }
  return undefined;
}

export type McpServerExtensionSource = {
  readonly name: string;
  readonly configEntry: McpServerEntry;
  readonly enabled: boolean;
  readonly status: McpServerStatus;
  readonly error?: string;
  readonly instructions?: string;
  readonly tools: readonly McpTool[];
  readonly hasResources: boolean;
  timeoutMs(): number;
  callTool(
    tool: string,
    args: Record<string, unknown>,
    options: McpRequestOptions,
  ): Promise<CallToolResult>;
};

function firstLine(text: string): string {
  return (text.split("\n", 1)[0] ?? "").trimEnd();
}

function configuredExposures(entry: McpServerEntry): Set<string> {
  return new Set([
    entry.config.exposure ?? DEFAULT_MCP_EXPOSURE,
    ...Object.values(entry.config.toolExposure ?? {}),
  ]);
}

function exposureText(entry: McpServerEntry): string {
  const exposures = configuredExposures(entry);
  return ["direct", "deferred", "codemode", "hidden"]
    .filter((exposure) => exposures.has(exposure))
    .join("+");
}

export function renderMcpServersSection(
  connections: readonly McpServerExtensionSource[],
  input?: PromptInput,
): string | undefined {
  const activeExtensions =
    input?.agent?.extensions === undefined
      ? undefined
      : new Set(input.agent.extensions.map((ext) => ext.name));
  const servers = connections.filter(
    (conn) =>
      conn.enabled &&
      (activeExtensions === undefined || activeExtensions.has(mcpServerExtensionName(conn.name))),
  );
  if (servers.length === 0) return undefined;

  const exposures = new Set(servers.flatMap((conn) => [...configuredExposures(conn.configEntry)]));
  const guidance = ["MCP servers available to this conversation."];
  if (exposures.has("deferred")) {
    guidance.push(
      "Deferred MCP tools are not offered initially; use tool_search to discover and load them.",
    );
  }
  if (exposures.has("codemode")) {
    guidance.push(
      "Codemode MCP tools are callable only from codemode scripts; use searchTools() or describeNamespace() there to discover them.",
    );
  }

  const lines = servers.map((conn) => {
    const entry = conn.configEntry;
    const namespace = mcpNamespace(entry.name);
    const exposure = exposureText(entry);
    const summary = mcpServerSummary(entry.config.description, conn.instructions);
    let state: string;
    if (conn.status === "connected" || conn.status === "degraded") {
      const resourceNote = conn.hasResources ? ", resources" : "";
      const degradedNote =
        conn.status === "degraded" && conn.error !== undefined
          ? `, degraded: ${firstLine(conn.error)}`
          : "";
      state = `${conn.status}, ${conn.tools.length} tool${conn.tools.length === 1 ? "" : "s"}${resourceNote}${degradedNote}`;
    } else if (conn.status === "auth_required") {
      state = "auth required";
    } else if (conn.status === "failed") {
      state = `failed${conn.error === undefined ? "" : `: ${firstLine(conn.error)}`}`;
    } else {
      state = conn.status;
    }
    return `- ${namespace} (${exposure}; ${state})${summary === "" ? "" : `: ${summary}`}`;
  });
  return [...guidance, ...lines].join("\n");
}

export function createMcpHubExtension(options: {
  readonly getConnections: () => readonly McpServerExtensionSource[];
  readonly host: McpResourceHost;
  readonly saveOutput: McpOutputSaver;
  readonly timeoutMs: number;
}): Extension {
  const hasResourceServers = options
    .getConnections()
    .some((conn) => conn.enabled && conn.hasResources);
  return defineExtension({
    name: MCP_EXTENSION,
    ...(hasResourceServers
      ? {
          tools: createMcpResourceTools({
            host: options.host,
            saveOutput: options.saveOutput,
            timeoutMs: options.timeoutMs,
          }),
        }
      : {}),
    sections: [
      {
        key: "mcp_servers",
        render: (input) => renderMcpServersSection(options.getConnections(), input),
      },
    ],
  });
}

export function createMcpServerExtensionEntry(options: {
  readonly connection: McpServerExtensionSource;
  readonly saveOutput: McpOutputSaver;
}): McpServerExtensionEntry {
  const { connection, saveOutput } = options;
  const entry = connection.configEntry;
  const summary = mcpServerSummary(entry.config.description, connection.instructions);
  const instructions = connection.instructions;
  const roles = resolveMcpServerRoles(entry.config);
  const extension = attachServerRoles(
    defineExtension({
      name: mcpServerExtensionName(entry.name),
      namespace: {
        name: mcpNamespace(entry.name),
        description: summary || `MCP server ${entry.name}`,
        ...(instructions === undefined ? {} : { instructions }),
      },
      tools: adaptMcpTools({
        server: entry.name,
        tools: connection.tools,
        config: entry.config,
        timeoutMs: connection.timeoutMs(),
        callTool: (tool, args, reqOptions) => connection.callTool(tool, args, reqOptions),
        saveOutput,
      }),
    }),
    roles,
  );
  return { server: entry.name, extension, roles };
}

type RegistryBinding = {
  readonly registry: Registry;
  installed: Set<string>;
};

export class McpRegistryBindings {
  private readonly bindings = new Set<RegistryBinding>();

  bind(registry: Registry, getExtensions: () => readonly Extension[]): () => void {
    const binding: RegistryBinding = { registry, installed: new Set() };
    this.bindings.add(binding);
    this.publishTo(binding, getExtensions());
    return () => {
      if (!this.bindings.delete(binding)) return;
      for (const name of binding.installed) registry.uninstall({ name });
      binding.installed.clear();
    };
  }

  publishAll(getExtensions: () => readonly Extension[]): void {
    if (this.bindings.size === 0) return;
    const extensions = getExtensions();
    for (const binding of [...this.bindings]) {
      try {
        this.publishTo(binding, extensions);
      } catch {
        // A registry may reject an update while tearing down; later state changes republish.
      }
    }
  }

  private publishTo(binding: RegistryBinding, desired: readonly Extension[]): void {
    const names = new Set<string>();
    for (const extension of desired) {
      binding.registry.install(extension);
      names.add(extension.name);
    }
    for (const name of binding.installed) {
      if (!names.has(name)) binding.registry.uninstall({ name });
    }
    binding.installed = names;
  }
}
