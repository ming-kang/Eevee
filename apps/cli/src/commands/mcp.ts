import { createInterface } from "node:readline/promises";
import { connectLocalEngine } from "@eevee/engine";
import {
  type McpLogsResponse,
  type McpOAuthEvent,
  PutMcpConfigRequestSchema,
  parseWithSchema,
} from "@eevee/protocol";
import type { Command } from "commander";
import {
  installSignalAbort,
  isRecord,
  parseKeyValueFlags,
  parsePositiveIntFlag,
  parseProjectIdFlag,
  readJsonInput,
} from "../args.ts";
import {
  formatMcpLogs,
  formatMcpState,
  formatMcpStatus,
  formatProjectMcpState,
} from "../format.ts";

const MCP_EXPOSURES = new Set(["deferred", "direct", "codemode", "hidden"]);

function parseNonEmptyServerName(raw: string): string {
  if (raw.trim().length === 0) {
    throw new Error("Invalid server name: must not be empty");
  }
  return raw;
}

export function registerMcpCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const mcpCommand = program
    .command("mcp")
    .description("Manage shared and project-scoped MCP servers");

  const runMcpStatus = async (options: { project?: string; logs?: boolean; json?: boolean }) => {
    const projectId = parseProjectIdFlag(options.project);
    const { client } = await connectLocalEngine(env);

    const fetchLogs = async (status: readonly { readonly name: string }[]) => {
      if (!options.logs) return undefined;
      const entries = await Promise.all(
        status.map((server) =>
          projectId === undefined
            ? client.getMcpLogs(server.name)
            : client.getProjectMcpLogs(projectId, server.name),
        ),
      );
      return {
        map: new Map<string, McpLogsResponse>(entries.map((entry) => [entry.server, entry])),
        record: Object.fromEntries(entries.map((entry) => [entry.server, entry])),
      };
    };

    if (projectId === undefined) {
      const state = await client.getMcpState();
      const fetched = await fetchLogs(state.status);
      if (options.json) {
        console.log(
          JSON.stringify(
            fetched === undefined ? state : { ...state, logs: fetched.record },
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        formatMcpState(state, options.logs ? { showLogs: true, logs: fetched?.map } : undefined),
      );
      return;
    }

    const state = await client.getProjectMcpState(projectId);
    const fetched = await fetchLogs(state.status);
    if (options.json) {
      console.log(
        JSON.stringify(fetched === undefined ? state : { ...state, logs: fetched.record }, null, 2),
      );
      return;
    }
    console.log(
      formatProjectMcpState(
        state,
        options.logs ? { showLogs: true, logs: fetched?.map } : undefined,
      ),
    );
  };

  mcpCommand
    .command("status")
    .description("Show configured MCP servers and their live connection status")
    .option("--project <projectId>", "Inspect MCP servers for a specific project")
    .option("--logs", "Fetch and display recent logs for each server")
    .option("--json", "Output JSON")
    .action(runMcpStatus);

  mcpCommand
    .command("list")
    .description("List configured MCP servers and their live connection status")
    .option("--project <projectId>", "Inspect MCP servers for a specific project")
    .option("--logs", "Fetch and display recent logs for each server")
    .option("--json", "Output JSON")
    .action(runMcpStatus);

  mcpCommand
    .command("set")
    .description("Replace all MCP server configurations from a JSON file or stdin")
    .option("--project <projectId>", "Replace MCP overrides/servers for a specific project")
    .option("--file <path>", "Path to MCP config JSON file")
    .option("--json", "Output JSON")
    .action(async (options: { project?: string; file?: string; json?: boolean }) => {
      const projectId = parseProjectIdFlag(options.project);
      const parsed = await readJsonInput(options.file);
      const candidate =
        isRecord(parsed) && "servers" in parsed
          ? parsed
          : isRecord(parsed) && "mcpServers" in parsed
            ? { servers: parsed.mcpServers }
            : { servers: parsed };
      const body = parseWithSchema(PutMcpConfigRequestSchema, candidate, "PutMcpConfigRequest");
      const { client } = await connectLocalEngine(env);
      if (projectId === undefined) {
        const state = await client.putMcpConfig(body);
        if (options.json) {
          console.log(JSON.stringify(state, null, 2));
          return;
        }
        console.log(formatMcpState(state));
        return;
      }

      const state = await client.putProjectMcpConfig(projectId, body);
      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }
      console.log(formatProjectMcpState(state));
    });

  mcpCommand
    .command("add")
    .description("Add or update an MCP server (or partial project override)")
    .argument("<name>", "MCP server name")
    .option("--project <projectId>", "Add or override an MCP server for a specific project")
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
    .option("--json", "Output JSON")
    .action(
      async (
        rawName: string,
        options: {
          project?: string;
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
          router?: boolean;
          worker?: boolean;
          json?: boolean;
        },
      ) => {
        const name = parseNonEmptyServerName(rawName);
        const projectId = parseProjectIdFlag(options.project);
        if (options.command !== undefined && options.url !== undefined) {
          throw new Error(
            projectId === undefined
              ? "Specify exactly one of --command or --url"
              : "Cannot combine --command and --url",
          );
        }
        if (projectId === undefined && options.command === undefined && options.url === undefined) {
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

        const isPartialOverride =
          projectId !== undefined && options.command === undefined && options.url === undefined;

        let roles: { router?: boolean; worker?: boolean } | undefined;
        if (options.router !== undefined || options.worker !== undefined) {
          if (isPartialOverride) {
            roles = {
              ...(options.router === undefined ? {} : { router: options.router }),
              ...(options.worker === undefined ? {} : { worker: options.worker }),
            };
          } else {
            roles = {
              router: options.router ?? true,
              worker: options.worker ?? true,
            };
          }
        }

        const config: Record<string, unknown> = {
          ...(options.command === undefined ? {} : { command: options.command }),
          ...(options.url === undefined ? {} : { url: options.url }),
          ...(options.args === undefined ? {} : { args: options.args }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(envVars === undefined ? {} : { env: envVars }),
          ...(headers === undefined ? {} : { headers }),
          ...(options.exposure === undefined ? {} : { exposure: options.exposure }),
          ...(options.description === undefined ? {} : { description: options.description }),
          ...(timeout === undefined ? {} : { timeout }),
          ...(options.disabled === undefined ? {} : { enabled: !options.disabled }),
          ...(roles === undefined ? {} : { roles }),
        };

        if (isPartialOverride && Object.keys(config).length === 0) {
          throw new Error(
            "Specify --command, --url, or at least one override flag (--exposure, --description, --timeout, --disabled, --router/--no-router, --worker/--no-worker)",
          );
        }

        const { client } = await connectLocalEngine(env);
        if (projectId === undefined) {
          const state = await client.upsertMcpServer(name, { config });
          if (options.json) {
            console.log(JSON.stringify(state, null, 2));
            return;
          }
          console.log(formatMcpState(state));
          return;
        }

        const state = await client.upsertProjectMcpServer(projectId, name, { config });
        if (options.json) {
          console.log(JSON.stringify(state, null, 2));
          return;
        }
        console.log(formatProjectMcpState(state));
      },
    );

  mcpCommand
    .command("remove")
    .description("Remove an MCP server or project override")
    .argument("<name>", "MCP server name")
    .option("--project <projectId>", "Remove a project-scoped MCP server or override")
    .option("--json", "Output JSON")
    .action(async (rawName: string, options: { project?: string; json?: boolean }) => {
      const name = parseNonEmptyServerName(rawName);
      const projectId = parseProjectIdFlag(options.project);
      const { client } = await connectLocalEngine(env);
      if (projectId === undefined) {
        const state = await client.deleteMcpServer(name);
        if (options.json) {
          console.log(JSON.stringify(state, null, 2));
          return;
        }
        console.log(formatMcpState(state));
        return;
      }

      const state = await client.deleteProjectMcpServer(projectId, name);
      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }
      console.log(formatProjectMcpState(state));
    });

  mcpCommand
    .command("reconnect")
    .description("Reconnect one or all enabled MCP servers")
    .argument("[name]", "Optional MCP server name")
    .option("--project <projectId>", "Reconnect MCP servers for a specific project")
    .option("--json", "Output JSON")
    .action(async (name: string | undefined, options: { project?: string; json?: boolean }) => {
      const projectId = parseProjectIdFlag(options.project);
      const { client } = await connectLocalEngine(env);
      const input = name === undefined ? {} : { server: name };
      const response =
        projectId === undefined
          ? await client.reconnectMcp(input)
          : await client.reconnectProjectMcp(projectId, input);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatMcpStatus(response.status));
    });

  mcpCommand
    .command("logs")
    .description("Show recent logs for an MCP server")
    .argument("<name>", "MCP server name")
    .option("--project <projectId>", "Fetch logs from a project-scoped MCP hub")
    .option("--json", "Output JSON")
    .action(async (rawName: string, options: { project?: string; json?: boolean }) => {
      const name = parseNonEmptyServerName(rawName);
      const projectId = parseProjectIdFlag(options.project);
      const { client } = await connectLocalEngine(env);
      const response =
        projectId === undefined
          ? await client.getMcpLogs(name)
          : await client.getProjectMcpLogs(projectId, name);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatMcpLogs(response));
    });

  mcpCommand
    .command("login")
    .description("Authenticate an HTTP MCP server via OAuth")
    .argument("<name>", "MCP server name")
    .option("--json", "Output JSON")
    .action(async (rawName: string, options: { json?: boolean }) => {
      const name = parseNonEmptyServerName(rawName);
      const { client } = await connectLocalEngine(env);
      const promptOut = options.json ? process.stderr : process.stdout;
      const controller = new AbortController();
      const cleanupSignal = installSignalAbort(controller);
      const promptController = new AbortController();
      let rl: ReturnType<typeof createInterface> | undefined;
      let promptStarted = false;
      let promptTask: Promise<void> | undefined;
      let cancelPromise: Promise<unknown> | undefined;
      let sessionId: string | undefined;

      const onAbort = () => {
        promptController.abort();
        rl?.close();
        if (sessionId !== undefined) {
          cancelPromise = client.cancelMcpOAuth(name, sessionId).catch(() => undefined);
        }
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });

      const startManualRedirectPrompt = (activeSessionId: string) => {
        if (promptStarted || process.stdin.isTTY !== true) return;
        promptStarted = true;
        const interfaceInstance = createInterface({
          input: process.stdin,
          output: promptOut,
          terminal: true,
        });
        rl = interfaceInstance;
        promptTask = (async () => {
          try {
            while (!promptController.signal.aborted && !controller.signal.aborted) {
              const answer = await interfaceInstance.question(
                "Paste redirect URL (or press Ctrl+C to cancel): ",
                { signal: promptController.signal },
              );
              const redirectUrl = answer.trim();
              if (redirectUrl.length === 0) continue;
              try {
                await client.submitMcpOAuthInput(name, activeSessionId, { redirectUrl });
                return;
              } catch (error) {
                if (promptController.signal.aborted || controller.signal.aborted) return;
                promptOut.write(`${error instanceof Error ? error.message : String(error)}\n`);
              }
            }
          } catch {
            // Abort or closed readline stops manual prompt when loopback completes or cancels.
          } finally {
            interfaceInstance.close();
          }
        })();
      };

      let terminalEvent: Extract<McpOAuthEvent, { type: "complete" | "error" }> | undefined;
      try {
        const session = await client.startMcpOAuth(name, controller.signal);
        sessionId = session.sessionId;
        if (controller.signal.aborted) {
          cancelPromise = client.cancelMcpOAuth(name, sessionId).catch(() => undefined);
          return;
        }
        for await (const event of client.streamMcpOAuth(name, session.sessionId, {
          signal: controller.signal,
        })) {
          if (event.type === "auth_url") {
            promptOut.write(`Open URL: ${event.url}\n`);
            if (event.instructions !== undefined) {
              promptOut.write(`${event.instructions}\n`);
            }
            startManualRedirectPrompt(session.sessionId);
          } else if (event.type === "progress") {
            promptOut.write(`${event.message}\n`);
          } else if (event.type === "complete" || event.type === "error") {
            terminalEvent = event;
            break;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        promptController.abort();
        rl?.close();
        await promptTask;
        await cancelPromise;
        controller.signal.removeEventListener("abort", onAbort);
        cleanupSignal();
      }

      if (controller.signal.aborted) {
        return;
      }
      if (terminalEvent === undefined) {
        throw new Error("MCP OAuth sign-in stream ended unexpectedly");
      }
      if (terminalEvent.type === "error") {
        if (options.json) {
          console.log(JSON.stringify(terminalEvent, null, 2));
          process.exitCode = 1;
          return;
        }
        throw new Error(`${terminalEvent.message} (${terminalEvent.code})`);
      }
      if (options.json) {
        console.log(JSON.stringify({ ok: true, server: name }, null, 2));
        return;
      }
      console.log(`Authenticated MCP server ${name}`);
    });

  mcpCommand
    .command("logout")
    .description("Remove stored OAuth credentials for an MCP server")
    .argument("<name>", "MCP server name")
    .option("--json", "Output JSON")
    .action(async (rawName: string, options: { json?: boolean }) => {
      const name = parseNonEmptyServerName(rawName);
      const { client } = await connectLocalEngine(env);
      const response = await client.logoutMcpOAuth(name);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(`Logged out of MCP server ${name}`);
    });
}
