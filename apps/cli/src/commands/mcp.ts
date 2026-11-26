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

export type MergeMcpAddOptions = {
  readonly isPartialOverride: boolean;
  readonly switchTransport: boolean;
};

export function mergeMcpAddConfig(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
  options: MergeMcpAddOptions,
): Record<string, unknown> {
  if (existing === undefined) {
    const created: Record<string, unknown> = { ...incoming };
    if (!options.isPartialOverride && isRecord(incoming.roles)) {
      created.roles = {
        router: incoming.roles.router ?? true,
        worker: incoming.roles.worker ?? true,
      };
    }
    return created;
  }

  const base: Record<string, unknown> = { ...existing };
  if (options.switchTransport) {
    if (incoming.command !== undefined) {
      delete base.url;
      delete base.headers;
      delete base.oauth;
      delete base.type;
    } else if (incoming.url !== undefined) {
      delete base.command;
      delete base.args;
      delete base.cwd;
      delete base.env;
      delete base.type;
    }
  }

  const merged: Record<string, unknown> = { ...base, ...incoming };
  if (isRecord(base.env) && isRecord(incoming.env)) {
    merged.env = { ...base.env, ...incoming.env };
  }
  if (isRecord(base.headers) && isRecord(incoming.headers)) {
    merged.headers = { ...base.headers, ...incoming.headers };
  }
  if (isRecord(incoming.roles)) {
    merged.roles = isRecord(base.roles)
      ? { ...base.roles, ...incoming.roles }
      : { ...incoming.roles };
  }
  return merged;
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
    .option("--replace", "Replace an existing server or override wholesale instead of merging")
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
          replace?: boolean;
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

        const explicitRoles =
          options.router !== undefined || options.worker !== undefined
            ? {
                ...(options.router === undefined ? {} : { router: options.router }),
                ...(options.worker === undefined ? {} : { worker: options.worker }),
              }
            : undefined;

        const incoming: Record<string, unknown> = {
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
          ...(explicitRoles === undefined ? {} : { roles: explicitRoles }),
        };

        if (isPartialOverride && Object.keys(incoming).length === 0) {
          throw new Error(
            "Specify --command, --url, or at least one override flag (--exposure, --description, --timeout, --disabled, --router/--no-router, --worker/--no-worker)",
          );
        }

        const { client } = await connectLocalEngine(env);
        let existing: Record<string, unknown> | undefined;
        let switchTransport = false;
        if (!options.replace) {
          if (projectId === undefined) {
            const state = await client.getMcpState();
            const found = state.servers[name];
            existing = isRecord(found) ? found : undefined;
          } else {
            const state = await client.getProjectMcpState(projectId);
            const found = state.projectServers[name];
            existing = isRecord(found) ? found : undefined;
          }
          if (existing !== undefined) {
            const existingIsHttp =
              typeof existing.url === "string" ||
              existing.type === "http" ||
              existing.type === "streamable-http";
            const existingIsStdio =
              typeof existing.command === "string" || existing.type === "stdio";
            switchTransport =
              (options.command !== undefined && existingIsHttp) ||
              (options.url !== undefined && existingIsStdio);
          }
        }
        const config = mergeMcpAddConfig(existing, incoming, {
          isPartialOverride,
          switchTransport,
        });

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
    .option("--project <projectId>", "Authenticate an MCP server for a specific project")
    .option("--json", "Output JSON")
    .action(async (rawName: string, options: { project?: string; json?: boolean }) => {
      const name = parseNonEmptyServerName(rawName);
      const projectId = parseProjectIdFlag(options.project);
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

      const cancelOAuthSession = (activeSessionId: string) =>
        (projectId === undefined
          ? client.cancelMcpOAuth(name, activeSessionId)
          : client.cancelProjectMcpOAuth(projectId, name, activeSessionId)
        ).catch(() => undefined);

      const onAbort = () => {
        promptController.abort();
        rl?.close();
        if (sessionId !== undefined) {
          cancelPromise = cancelOAuthSession(sessionId);
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
                if (projectId === undefined) {
                  await client.submitMcpOAuthInput(name, activeSessionId, { redirectUrl });
                } else {
                  await client.submitProjectMcpOAuthInput(projectId, name, activeSessionId, {
                    redirectUrl,
                  });
                }
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
        const session =
          projectId === undefined
            ? await client.startMcpOAuth(name, controller.signal)
            : await client.startProjectMcpOAuth(projectId, name, controller.signal);
        sessionId = session.sessionId;
        if (controller.signal.aborted) {
          cancelPromise = cancelOAuthSession(sessionId);
          return;
        }
        const stream =
          projectId === undefined
            ? client.streamMcpOAuth(name, session.sessionId, { signal: controller.signal })
            : client.streamProjectMcpOAuth(projectId, name, session.sessionId, {
                signal: controller.signal,
              });
        for await (const event of stream) {
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
        console.log(
          JSON.stringify(
            { ok: true, server: name, ...(projectId === undefined ? {} : { projectId }) },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Authenticated MCP server ${name}`);
    });

  mcpCommand
    .command("logout")
    .description("Remove stored OAuth credentials for an MCP server")
    .argument("<name>", "MCP server name")
    .option("--project <projectId>", "Remove stored OAuth credentials for a project MCP server")
    .option("--json", "Output JSON")
    .action(async (rawName: string, options: { project?: string; json?: boolean }) => {
      const name = parseNonEmptyServerName(rawName);
      const projectId = parseProjectIdFlag(options.project);
      const { client } = await connectLocalEngine(env);
      const response =
        projectId === undefined
          ? await client.logoutMcpOAuth(name)
          : await client.logoutProjectMcpOAuth(projectId, name);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(`Logged out of MCP server ${name}`);
    });
}
