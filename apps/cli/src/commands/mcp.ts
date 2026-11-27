import { connectLocalEngine } from "@eevee/engine";
import {
  type EeveeClient,
  type McpLogsResponse,
  McpServerConfigSchema,
  McpServerEntryInputSchema,
  type McpStateResponse,
  type ProjectMcpStateResponse,
  PutGlobalMcpConfigRequestSchema,
  PutMcpConfigRequestSchema,
  parseWithSchema,
} from "@eevee/protocol";
import type { Command } from "commander";
import { isRecord, parseNonEmpty, parseProjectIdFlag, readJsonInput } from "../args.ts";
import { printResult, runEngineCommand } from "../command-helpers.ts";
import { formatMcpLogs, formatMcpStatus, formatScopedMcpState } from "../format.ts";
import { runMcpOAuthLogin } from "../login-ui.ts";
import {
  type McpAddOptions,
  mergeMcpAddConfig,
  parseMcpAddIncoming,
  shouldSwitchMcpTransport,
} from "../mcp-config.ts";

export { mergeMcpAddConfig };

type ScopedOpts = { project?: string; json?: boolean };

type ScopedMcpStateWithLogs = (McpStateResponse | ProjectMcpStateResponse) & {
  readonly logs?: Readonly<Record<string, McpLogsResponse>>;
};

export function registerMcpCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const mcpCommand = program
    .command("mcp")
    .description("Manage shared and project-scoped MCP servers");

  const namedCmd = (name: string, desc: string, projectDesc: string) =>
    mcpCommand
      .command(name)
      .description(desc)
      .argument("<name>", "MCP server name")
      .option("--project <projectId>", projectDesc)
      .option("--json", "Output JSON");

  const runScoped = <T>(
    rawName: string,
    options: ScopedOpts,
    run: (mcp: ReturnType<EeveeClient["mcp"]>, name: string) => Promise<T>,
    format: (result: T, name: string) => string,
  ) => {
    const name = parseNonEmpty(rawName, "server name");
    const projectId = parseProjectIdFlag(options.project);
    return runEngineCommand(
      env,
      options,
      (c) => run(c.mcp(projectId), name),
      (r) => format(r, name),
    );
  };

  for (const [cmdName, desc] of [
    ["status", "Show configured MCP servers and their live connection status"],
    ["list", "List configured MCP servers and their live connection status"],
  ] as const) {
    mcpCommand
      .command(cmdName)
      .description(desc)
      .option("--project <projectId>", "Inspect MCP servers for a specific project")
      .option("--logs", "Fetch and display recent logs for each server")
      .option("--json", "Output JSON")
      .action((options: ScopedOpts & { logs?: boolean }) => {
        const projectId = parseProjectIdFlag(options.project);
        return runEngineCommand<ScopedMcpStateWithLogs>(
          env,
          options,
          async (client) => {
            const mcp = client.mcp(projectId);
            const state = await mcp.getState();
            if (!options.logs) return state;
            const entries = await Promise.all(state.status.map((s) => mcp.getLogs(s.name)));
            return { ...state, logs: Object.fromEntries(entries.map((e) => [e.server, e])) };
          },
          (result) =>
            formatScopedMcpState(
              result,
              result.logs === undefined
                ? undefined
                : { showLogs: true, logs: new Map(Object.entries(result.logs)) },
            ),
        );
      });
  }

  mcpCommand
    .command("set")
    .description("Replace all MCP server configurations from a JSON file or stdin")
    .option("--project <projectId>", "Replace MCP overrides/servers for a specific project")
    .option("--file <path>", "Path to MCP config JSON file")
    .option("--json", "Output JSON")
    .action(async (options: ScopedOpts & { file?: string }) => {
      const projectId = parseProjectIdFlag(options.project);
      const parsed = await readJsonInput(options.file);
      const candidate =
        isRecord(parsed) && "servers" in parsed
          ? parsed
          : { servers: isRecord(parsed) && "mcpServers" in parsed ? parsed.mcpServers : parsed };
      const body =
        projectId === undefined
          ? parseWithSchema(PutGlobalMcpConfigRequestSchema, candidate, "PutGlobalMcpConfigRequest")
          : parseWithSchema(PutMcpConfigRequestSchema, candidate, "PutMcpConfigRequest");
      await runEngineCommand(
        env,
        options,
        (c) => c.mcp(projectId).putConfig(body),
        formatScopedMcpState,
      );
    });

  namedCmd(
    "add",
    "Add or update an MCP server (or partial project override)",
    "Add or override an MCP server for a specific project",
  )
    .option("--command <cmd>", "Stdio command")
    .option("--args <args...>", "Stdio command arguments")
    .option("--url <url>", "Streamable HTTP server URL")
    .option(
      "--exposure <mode>",
      "Tool exposure mode: deferred, direct, codemode, or hidden (default: codemode)",
    )
    .option("--description <text>", "Server description")
    .option("--cwd <dir>", "Working directory for stdio server")
    .option("--env <pairs...>", "Stdio environment variables (KEY=VALUE)")
    .option("--header <pairs...>", "HTTP headers (KEY=VALUE)")
    .option("--timeout <sec>", "Request timeout in seconds")
    .option("--disabled", "Disable the server")
    .option("--no-disabled", "Enable the server")
    .option("--router", "Enable MCP tools for Router")
    .option("--no-router", "Disable MCP tools for Router")
    .option("--worker", "Enable MCP tools for Workers")
    .option("--no-worker", "Disable MCP tools for Workers")
    .option("--replace", "Replace an existing server or override wholesale instead of merging")
    .action((rawName: string, options: McpAddOptions) => {
      const projectId = parseProjectIdFlag(options.project);
      const { incoming, isPartialOverride } = parseMcpAddIncoming(options, projectId);
      return runScoped(
        rawName,
        options,
        async (mcp, name) => {
          const state = options.replace ? undefined : await mcp.getState();
          const found = state
            ? ("projectServers" in state ? state.projectServers : state.servers)[name]
            : undefined;
          const existing = isRecord(found) ? found : undefined;
          const merged = mergeMcpAddConfig(existing, incoming, {
            isPartialOverride,
            switchTransport: shouldSwitchMcpTransport(existing, options),
          });
          const config =
            projectId === undefined
              ? parseWithSchema(McpServerConfigSchema, merged, "McpServerConfig")
              : parseWithSchema(McpServerEntryInputSchema, merged, "McpServerEntryInput");
          return mcp.upsertServer(name, { config });
        },
        (s) => formatScopedMcpState(s),
      );
    });

  namedCmd(
    "remove",
    "Remove an MCP server or project override",
    "Remove a project-scoped MCP server or override",
  ).action((n: string, o: ScopedOpts) =>
    runScoped(
      n,
      o,
      (m, s) => m.deleteServer(s),
      (s) => formatScopedMcpState(s),
    ),
  );

  mcpCommand
    .command("reconnect")
    .description("Reconnect one or all enabled MCP servers")
    .argument("[name]", "Optional MCP server name")
    .option("--project <projectId>", "Reconnect MCP servers for a specific project")
    .option("--json", "Output JSON")
    .action((name: string | undefined, options: ScopedOpts) => {
      const projectId = parseProjectIdFlag(options.project);
      return runEngineCommand(
        env,
        options,
        (c) => c.mcp(projectId).reconnect(name === undefined ? {} : { server: name }),
        (r) => formatMcpStatus(r.status),
      );
    });

  namedCmd(
    "logs",
    "Show recent logs for an MCP server",
    "Fetch logs from a project-scoped MCP hub",
  ).action((n: string, o: ScopedOpts) => runScoped(n, o, (m, s) => m.getLogs(s), formatMcpLogs));

  namedCmd(
    "login",
    "Authenticate an HTTP MCP server via OAuth",
    "Authenticate an MCP server for a specific project",
  ).action(async (rawName: string, options: ScopedOpts) => {
    const name = parseNonEmpty(rawName, "server name");
    const projectId = parseProjectIdFlag(options.project);
    const { client } = await connectLocalEngine(env);
    const result = await runMcpOAuthLogin({
      client,
      serverName: name,
      projectId,
      json: options.json,
    });
    if (result !== undefined)
      printResult(result, options, () => `Authenticated MCP server ${name}`);
  });

  namedCmd(
    "logout",
    "Remove stored OAuth credentials for an MCP server",
    "Remove stored OAuth credentials for a project MCP server",
  ).action((n: string, o: ScopedOpts) =>
    runScoped(
      n,
      o,
      (m, s) => m.logoutOAuth(s),
      (_, s) => `Logged out of MCP server ${s}`,
    ),
  );
}
