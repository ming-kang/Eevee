import { connectLocalEngine } from "@eevee/engine";
import { PutMcpConfigRequestSchema, parseWithSchema } from "@eevee/protocol";
import type { Command } from "commander";
import { isRecord, parseKeyValueFlags, parsePositiveIntFlag, readJsonInput } from "../args.ts";
import { formatMcpState, formatMcpStatus } from "../format.ts";

const MCP_EXPOSURES = new Set(["deferred", "direct", "codemode", "hidden"]);

export function registerMcpCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const mcpCommand = program.command("mcp").description("Manage shared MCP servers");

  const runMcpStatus = async (options: { json?: boolean }) => {
    const { client } = await connectLocalEngine(env);
    const state = await client.getMcpState();
    if (options.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    console.log(formatMcpState(state));
  };

  mcpCommand
    .command("status")
    .description("Show configured MCP servers and their live connection status")
    .option("--json", "Output JSON")
    .action(runMcpStatus);

  mcpCommand
    .command("list")
    .description("List configured MCP servers and their live connection status")
    .option("--json", "Output JSON")
    .action(runMcpStatus);

  mcpCommand
    .command("set")
    .description("Replace all MCP server configurations from a JSON file or stdin")
    .option("--file <path>", "Path to MCP config JSON file")
    .option("--json", "Output JSON")
    .action(async (options: { file?: string; json?: boolean }) => {
      const parsed = await readJsonInput(options.file);
      const candidate =
        isRecord(parsed) && "servers" in parsed
          ? parsed
          : isRecord(parsed) && "mcpServers" in parsed
            ? { servers: parsed.mcpServers }
            : { servers: parsed };
      const body = parseWithSchema(PutMcpConfigRequestSchema, candidate, "PutMcpConfigRequest");
      const { client } = await connectLocalEngine(env);
      const state = await client.putMcpConfig(body);
      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }
      console.log(formatMcpState(state));
    });

  mcpCommand
    .command("add")
    .description("Add or update an MCP server")
    .argument("<name>", "MCP server name")
    .option("--command <cmd>", "Stdio command")
    .option("--args <args...>", "Stdio command arguments")
    .option("--url <url>", "Streamable HTTP server URL")
    .option("--exposure <mode>", "Tool exposure mode: deferred, direct, codemode, or hidden")
    .option("--description <text>", "Server description")
    .option("--cwd <dir>", "Working directory for stdio server")
    .option("--env <pairs...>", "Stdio environment variables (KEY=VALUE)")
    .option("--header <pairs...>", "HTTP headers (KEY=VALUE)")
    .option("--timeout <sec>", "Request timeout in seconds")
    .option("--disabled", "Add the server disabled")
    .option("--json", "Output JSON")
    .action(
      async (
        name: string,
        options: {
          command?: string;
          args?: string[];
          url?: string;
          exposure?: string;
          description?: string;
          cwd?: string;
          env?: string[];
          header?: string[];
          timeout?: string;
          disabled?: boolean;
          json?: boolean;
        },
      ) => {
        if ((options.command === undefined) === (options.url === undefined)) {
          throw new Error("Specify exactly one of --command or --url");
        }
        if (options.exposure !== undefined && !MCP_EXPOSURES.has(options.exposure)) {
          throw new Error(
            `Invalid --exposure "${options.exposure}": expected deferred, direct, codemode, or hidden`,
          );
        }
        const envVars = parseKeyValueFlags(options.env, "--env");
        const headers = parseKeyValueFlags(options.header, "--header");
        const timeout =
          options.timeout === undefined
            ? undefined
            : parsePositiveIntFlag(options.timeout, "--timeout");

        const config: Record<string, unknown> = {
          ...(options.command !== undefined ? { command: options.command } : { url: options.url }),
          ...(options.args === undefined ? {} : { args: options.args }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(envVars === undefined ? {} : { env: envVars }),
          ...(headers === undefined ? {} : { headers }),
          ...(options.exposure === undefined ? {} : { exposure: options.exposure }),
          ...(options.description === undefined ? {} : { description: options.description }),
          ...(timeout === undefined ? {} : { timeout }),
          ...(options.disabled ? { enabled: false } : {}),
        };

        const { client } = await connectLocalEngine(env);
        const state = await client.upsertMcpServer(name, { config });
        if (options.json) {
          console.log(JSON.stringify(state, null, 2));
          return;
        }
        console.log(formatMcpState(state));
      },
    );

  mcpCommand
    .command("remove")
    .description("Remove an MCP server")
    .argument("<name>", "MCP server name")
    .option("--json", "Output JSON")
    .action(async (name: string, options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const state = await client.deleteMcpServer(name);
      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }
      console.log(formatMcpState(state));
    });

  mcpCommand
    .command("reconnect")
    .description("Reconnect one or all enabled MCP servers")
    .argument("[name]", "Optional MCP server name")
    .option("--json", "Output JSON")
    .action(async (name: string | undefined, options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.reconnectMcp(name === undefined ? {} : { server: name });
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatMcpStatus(response.status));
    });
}
