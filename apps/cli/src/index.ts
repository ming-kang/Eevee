#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  connectLocalEngine,
  DEFAULT_ENGINE_PORT,
  dataDirLayout,
  ENGINE_VERSION,
  getDaemonStatus,
  resolveDataDir,
  startDaemon,
  stopDaemon,
} from "@eevee/engine";
import {
  type AuthType,
  ConfigBundleSchema,
  type ConversationRef,
  ConversationRefSchema,
  type EngineSettings,
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  type ModelSlotsOverride,
  PROTOCOL_VERSION,
  PutMcpConfigRequestSchema,
  parseWithSchema,
  QuestionIdSchema,
  type TaskReadMode,
  TaskReadModeSchema,
  type UpdateProjectRequest,
  type WhenBusy,
  WhenBusySchema,
  WorkerIdSchema,
} from "@eevee/protocol";
import { Command } from "commander";
import {
  ConversationWatchRenderer,
  formatBoard,
  formatMcpState,
  formatMcpStatus,
  formatModelProfiles,
  formatModels,
  formatProjectUsage,
  formatProviders,
  formatQuestionAnswered,
  formatRefreshModels,
  formatSettings,
  formatTaskOutput,
  parseModelFlag,
} from "./format.ts";
import { formatDaemonStatus, runForegroundEngine, runSupervisorProcess } from "./lifecycle.ts";

function parsePort(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Invalid port "${raw}": expected integer 0..65535`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port "${raw}": expected integer 0..65535`);
  }
  return port;
}

function parsePositiveIntFlag(raw: string, flagName: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`Invalid ${flagName} "${raw}": expected positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${flagName} "${raw}": expected positive integer`);
  }
  return value;
}

function parseNonNegativeIntFlag(raw: string, flagName: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`Invalid ${flagName} "${raw}": expected non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${flagName} "${raw}": expected non-negative integer`);
  }
  return value;
}

function parseConversationRefArg(raw: string | undefined): ConversationRef {
  return parseWithSchema(ConversationRefSchema, raw ?? "router", "ref");
}

function parseNonEmptyTaskId(raw: string): string {
  if (raw.trim().length === 0) {
    throw new Error("Invalid taskId: must not be empty");
  }
  return raw;
}

function installSignalAbort(controller: AbortController): () => void {
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("Provide --file <path> or pipe input via stdin.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readTextInput(filePath?: string): Promise<string> {
  if (filePath !== undefined) {
    return readFile(resolve(filePath), "utf8");
  }
  return readStdinText();
}

async function readJsonInput(filePath?: string): Promise<unknown> {
  const raw = await readTextInput(filePath);
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseKeyValueFlags(
  entries: readonly string[] | undefined,
  flagName: string,
): Record<string, string> | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const record: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid ${flagName} "${entry}": expected KEY=VALUE`);
    }
    record[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return record;
}

const MCP_EXPOSURES = new Set(["deferred", "direct", "codemode", "hidden"]);

export function createProgram(env: NodeJS.ProcessEnv = process.env): Command {
  const program = new Command();
  program.name("eevee").description("Eevee proactive agent CLI").version(ENGINE_VERSION);

  program
    .command("info")
    .description("Show resolved Eevee home layout and protocol version")
    .action(() => {
      const layout = dataDirLayout(resolveDataDir(env));
      console.log(
        JSON.stringify(
          {
            engineVersion: ENGINE_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            home: layout.root,
            authFile: layout.authFile,
            modelsFile: layout.modelsFile,
            engineDb: layout.engineDb,
            tokenFile: layout.tokenFile,
            stateFile: layout.stateFile,
            supervisorStateFile: layout.supervisorStateFile,
            daemonLogFile: layout.daemonLogFile,
          },
          null,
          2,
        ),
      );
    });

  program
    .command("start")
    .description("Start the local Eevee Engine")
    .option("--foreground", "Run the Engine in the foreground without a supervisor")
    .option("--port <port>", "Port to listen on (127.0.0.1 only)")
    .option("--json", "Output JSON (background mode only)")
    .action(async (options: { foreground?: boolean; port?: string; json?: boolean }) => {
      const port = options.port === undefined ? DEFAULT_ENGINE_PORT : parsePort(options.port);
      if (options.foreground) {
        await runForegroundEngine({ env, port });
        return;
      }
      const result = await startDaemon({
        env,
        port,
        cliEntry: fileURLToPath(import.meta.url),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        result.outcome === "already_running"
          ? `Eevee engine is already running at ${result.url} (pid ${result.enginePid})`
          : `Started Eevee engine at ${result.url} (pid ${result.enginePid}, supervisor pid ${result.supervisorPid})`,
      );
    });

  program
    .command("stop")
    .description("Stop the supervised local Eevee Engine")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const result = await stopDaemon({ env });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        result.outcome === "already_stopped"
          ? "Eevee engine is already stopped"
          : "Stopped Eevee engine",
      );
    });

  program
    .command("status")
    .description("Show local Eevee Engine and supervisor status")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const status = await getDaemonStatus({ env });
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(formatDaemonStatus(status));
    });

  program
    .command("__supervisor", { hidden: true })
    .description("Run the Eevee supervisor process")
    .option("--port <port>", "Port for the supervised Engine")
    .action(async (options: { port?: string }) => {
      const port = options.port === undefined ? DEFAULT_ENGINE_PORT : parsePort(options.port);
      await runSupervisorProcess({ env, port, cliEntry: fileURLToPath(import.meta.url) });
    });

  const projectCommand = program.command("project").description("Manage Eevee projects");

  projectCommand
    .command("create")
    .description("Create a new project")
    .argument("[workspaces...]", "Workspace directories (defaults to current working directory)")
    .option("--title <title>", "Human-readable project title")
    .option("--memory <text>", "Initial project memory instructions")
    .option("--router-model <provider/modelId>", "Router model override")
    .option("--worker-model <provider/modelId>", "Worker model override")
    .option("--dreamer-model <provider/modelId>", "Dreamer model override")
    .option("--json", "Output JSON")
    .action(
      async (
        workspaces: string[],
        options: {
          title?: string;
          memory?: string;
          routerModel?: string;
          workerModel?: string;
          dreamerModel?: string;
          json?: boolean;
        },
      ) => {
        const resolvedWorkspaces = (workspaces.length > 0 ? workspaces : [process.cwd()]).map(
          (dir) => resolve(dir),
        );
        const models: ModelSlotsOverride = {
          ...(options.routerModel === undefined
            ? {}
            : { router: parseModelFlag(options.routerModel, "--router-model") }),
          ...(options.workerModel === undefined
            ? {}
            : { worker: parseModelFlag(options.workerModel, "--worker-model") }),
          ...(options.dreamerModel === undefined
            ? {}
            : { dreamer: parseModelFlag(options.dreamerModel, "--dreamer-model") }),
        };
        const hasModels =
          models.router !== undefined ||
          models.worker !== undefined ||
          models.dreamer !== undefined;

        const { client } = await connectLocalEngine(env);
        const response = await client.createProject({
          workspaces: resolvedWorkspaces,
          ...(options.title === undefined ? {} : { title: options.title }),
          ...(options.memory === undefined ? {} : { memory: options.memory }),
          ...(hasModels ? { models } : {}),
        });

        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        const { project } = response;
        console.log(`Created project ${project.id} (${project.title})`);
        console.log(`Workspaces: ${project.workspaces.join(", ")}`);
      },
    );

  projectCommand
    .command("list")
    .description("List projects hosted by the local Engine")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.listProjects();
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      if (response.projects.length === 0) {
        console.log("No projects.");
        return;
      }
      for (const project of response.projects) {
        console.log(`${project.id}\t${project.title}\t${project.workspaces.join(", ")}`);
      }
    });

  projectCommand
    .command("update")
    .description("Update project metadata, workspaces, memory, or model overrides")
    .argument("<project>", "Project ID")
    .option("--title <title>", "New project title")
    .option("--workspace <dirs...>", "Replace project workspace directories")
    .option("--memory <text>", "Set project memory instructions")
    .option("--clear-memory", "Clear project memory instructions")
    .option("--router-model <provider/modelId>", "Router model override")
    .option("--worker-model <provider/modelId>", "Worker model override")
    .option("--dreamer-model <provider/modelId>", "Dreamer model override")
    .option("--clear-models", "Clear project model overrides")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        options: {
          title?: string;
          workspace?: string[];
          memory?: string;
          clearMemory?: boolean;
          routerModel?: string;
          workerModel?: string;
          dreamerModel?: string;
          clearModels?: boolean;
          json?: boolean;
        },
      ) => {
        if (options.memory !== undefined && options.clearMemory) {
          throw new Error("Cannot combine --memory and --clear-memory");
        }
        const hasModelFlag =
          options.routerModel !== undefined ||
          options.workerModel !== undefined ||
          options.dreamerModel !== undefined;
        if (hasModelFlag && options.clearModels) {
          throw new Error("Cannot combine model override flags with --clear-models");
        }

        const patch: {
          title?: string;
          workspaces?: string[];
          memory?: string | null;
          models?: ModelSlotsOverride | null;
        } = {};
        if (options.title !== undefined) patch.title = options.title;
        if (options.workspace !== undefined) {
          patch.workspaces = options.workspace.map((dir) => resolve(dir));
        }
        if (options.clearMemory) patch.memory = null;
        else if (options.memory !== undefined) patch.memory = options.memory;

        if (options.clearModels) {
          patch.models = null;
        } else if (hasModelFlag) {
          patch.models = {
            ...(options.routerModel === undefined
              ? {}
              : { router: parseModelFlag(options.routerModel, "--router-model") }),
            ...(options.workerModel === undefined
              ? {}
              : { worker: parseModelFlag(options.workerModel, "--worker-model") }),
            ...(options.dreamerModel === undefined
              ? {}
              : { dreamer: parseModelFlag(options.dreamerModel, "--dreamer-model") }),
          };
        }

        if (Object.keys(patch).length === 0) {
          throw new Error("Specify at least one field to update.");
        }

        const { client } = await connectLocalEngine(env);
        const response = await client.updateProject(projectId, patch as UpdateProjectRequest);
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(`Updated project ${response.project.id} (${response.project.title})`);
      },
    );

  projectCommand
    .command("remove")
    .description("Remove a project and its session data (never deletes workspace files)")
    .argument("<project>", "Project ID")
    .option("--json", "Output JSON")
    .action(async (projectId: string, options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.deleteProject(projectId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(`Removed project ${response.id}`);
    });

  const projectMemoryCommand = projectCommand
    .command("memory")
    .description("Read or update project memory instructions");

  projectMemoryCommand
    .command("get")
    .description("Get project memory instructions")
    .argument("<project>", "Project ID")
    .option("--json", "Output JSON")
    .action(async (projectId: string, options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.getProjectMemory(projectId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(response.memory ?? "(no project memory)");
    });

  projectMemoryCommand
    .command("set")
    .description("Set or clear project memory instructions")
    .argument("<project>", "Project ID")
    .argument("[text]", "Project memory text")
    .option("--file <path>", "Read project memory from a file")
    .option("--clear", "Clear project memory")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        text: string | undefined,
        options: { file?: string; clear?: boolean; json?: boolean },
      ) => {
        const sources = [
          text !== undefined ? 1 : 0,
          options.file !== undefined ? 1 : 0,
          options.clear ? 1 : 0,
        ].reduce((a, b) => a + b, 0);
        if (sources > 1) {
          throw new Error("Specify only one of [text], --file, or --clear");
        }
        const memory = options.clear
          ? null
          : text !== undefined
            ? text
            : await readTextInput(options.file);
        const { client } = await connectLocalEngine(env);
        const response = await client.putProjectMemory(projectId, { memory });
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(
          response.memory === null
            ? `Cleared project memory for ${response.projectId}`
            : `Updated project memory for ${response.projectId}`,
        );
      },
    );

  projectCommand
    .command("usage")
    .description("Show accumulated model and tool usage for a project")
    .argument("<project>", "Project ID")
    .option("--json", "Output JSON")
    .action(async (projectId: string, options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.getProjectUsage(projectId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatProjectUsage(response));
    });

  const authCommand = program.command("auth").description("Manage provider credentials");

  authCommand
    .command("status")
    .description("List provider authentication status")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.listProviders();
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatProviders(response));
    });

  authCommand
    .command("login")
    .description("Authenticate a provider via API key or interactive OAuth")
    .argument("<provider>", "Provider ID")
    .option("--api-key <key>", "Store an API key non-interactively")
    .option("--oauth", "Use interactive OAuth login")
    .option("--json", "Output JSON")
    .action(
      async (providerId: string, options: { apiKey?: string; oauth?: boolean; json?: boolean }) => {
        if (options.apiKey !== undefined && options.oauth) {
          throw new Error("Cannot combine --api-key and --oauth");
        }
        const { client } = await connectLocalEngine(env);
        if (options.apiKey !== undefined) {
          const response = await client.setProviderApiKey(providerId, { key: options.apiKey });
          if (options.json) {
            console.log(JSON.stringify(response, null, 2));
            return;
          }
          console.log(`Saved API key for ${providerId}`);
          return;
        }

        const { providers } = await client.listProviders();
        const provider = providers.find((entry) => entry.id === providerId);
        if (provider === undefined) {
          throw new Error(`Unknown provider "${providerId}"`);
        }

        const promptOut = options.json ? process.stderr : process.stdout;
        let echoMuted = false;
        const echoOut = new Writable({
          write(chunk, encoding, callback) {
            if (echoMuted) callback();
            else promptOut.write(chunk, encoding, () => callback());
          },
        });
        const rl = createInterface({
          input: process.stdin,
          output: echoOut,
          terminal: process.stdin.isTTY === true,
        });
        const questionHidden = async (query: string): Promise<string> => {
          promptOut.write(query);
          echoMuted = true;
          try {
            return await rl.question("");
          } finally {
            echoMuted = false;
            promptOut.write("\n");
          }
        };
        let loginType: AuthType;
        try {
          if (options.oauth) {
            if (!provider.authMethods.oauth) {
              throw new Error(`Provider "${providerId}" does not support OAuth login`);
            }
            loginType = "oauth";
          } else if (provider.authMethods.oauth && !provider.authMethods.apiKeyLogin) {
            loginType = "oauth";
          } else if (!provider.authMethods.oauth && provider.authMethods.apiKeyLogin) {
            loginType = "api_key";
          } else if (provider.authMethods.oauth && provider.authMethods.apiKeyLogin) {
            const oauthLabel =
              provider.authMethods.oauthLabel ?? provider.authMethods.oauthName ?? "OAuth";
            promptOut.write(`Choose login method for ${provider.name}:\n`);
            promptOut.write(`  1) ${oauthLabel}\n`);
            promptOut.write("  2) API key\n");
            const choice = (await rl.question("Select [1/2]: ")).trim();
            if (choice === "1" || choice.toLowerCase() === "oauth") {
              loginType = "oauth";
            } else if (choice === "2" || choice.toLowerCase() === "api_key") {
              loginType = "api_key";
            } else {
              throw new Error(`Invalid login method selection "${choice}"`);
            }
          } else {
            throw new Error(
              `Provider "${providerId}" does not support interactive login; pass --api-key <key>.`,
            );
          }

          const session = await client.startProviderLogin(providerId, { type: loginType });
          const controller = new AbortController();
          const onSignal = () => {
            controller.abort();
            void client.cancelLoginSession(providerId, session.sessionId).catch(() => undefined);
          };
          process.on("SIGINT", onSignal);
          process.on("SIGTERM", onSignal);
          try {
            for await (const item of client.streamLoginSession(providerId, session.sessionId, {
              signal: controller.signal,
            })) {
              if (item.type === "auth") {
                const evt = item.event;
                if (evt.type === "auth_url") {
                  promptOut.write(`Open URL: ${evt.url}\n`);
                  if (evt.instructions) promptOut.write(`${evt.instructions}\n`);
                } else if (evt.type === "device_code") {
                  promptOut.write(`Enter code ${evt.userCode} at ${evt.verificationUri}\n`);
                } else {
                  promptOut.write(`${evt.message}\n`);
                }
              } else if (item.type === "prompt") {
                const prompt = item.prompt;
                let value: string;
                if (prompt.type === "select") {
                  promptOut.write(`${prompt.message}\n`);
                  prompt.options.forEach((opt, idx) => {
                    const desc = opt.description ? ` — ${opt.description}` : "";
                    promptOut.write(`  ${idx + 1}) ${opt.label} (${opt.id})${desc}\n`);
                  });
                  const answer = (await rl.question("Select option: ")).trim();
                  const asIndex = Number(answer);
                  if (
                    Number.isInteger(asIndex) &&
                    asIndex >= 1 &&
                    asIndex <= prompt.options.length
                  ) {
                    value = prompt.options[asIndex - 1]?.id ?? answer;
                  } else {
                    value = answer;
                  }
                } else {
                  const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
                  const query = `${prompt.message}${suffix}: `;
                  value =
                    prompt.type === "secret"
                      ? await questionHidden(query)
                      : await rl.question(query);
                }
                await client.submitLoginInput(providerId, session.sessionId, {
                  promptId: prompt.promptId,
                  value,
                });
              } else if (item.type === "complete") {
                if (options.json) {
                  console.log(JSON.stringify(item.complete, null, 2));
                } else {
                  console.log(`Authenticated ${item.complete.providerId} (${item.complete.type})`);
                }
                return;
              } else if (item.type === "error") {
                throw new Error(item.error.message);
              }
            }
          } finally {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
          }
        } finally {
          rl.close();
        }
      },
    );

  authCommand
    .command("logout")
    .description("Remove stored credentials for a provider")
    .argument("<provider>", "Provider ID")
    .option("--json", "Output JSON")
    .action(async (providerId: string, options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.logoutProvider(providerId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(`Logged out of ${providerId}`);
    });

  const modelsCommand = program.command("models").description("Inspect and manage models");

  modelsCommand
    .command("list")
    .description("List available and configured chat models")
    .option("--provider <id>", "Filter by provider ID")
    .option("--available", "Show only configured/available models")
    .option("--json", "Output JSON")
    .action(async (options: { provider?: string; available?: boolean; json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.listModels({
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.available ? { available: true } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatModels(response));
    });

  modelsCommand
    .command("refresh")
    .description("Refresh dynamic provider model catalogs")
    .option("--provider <ids...>", "Restrict refresh to these provider IDs")
    .option("--force", "Bypass freshness checks")
    .option("--json", "Output JSON")
    .action(async (options: { provider?: string[]; force?: boolean; json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.refreshModels({
        ...(options.provider === undefined ? {} : { providers: options.provider }),
        ...(options.force ? { force: true } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatRefreshModels(response));
    });

  const profilesCommand = modelsCommand
    .command("profiles")
    .description("Get or set Router model profiles");

  profilesCommand
    .command("get")
    .description("Get model profiles document")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const doc = await client.getModelProfiles();
      if (options.json) {
        console.log(JSON.stringify(doc, null, 2));
        return;
      }
      console.log(formatModelProfiles(doc));
    });

  profilesCommand
    .command("set")
    .description("Replace model profiles document from a JSON file or stdin")
    .option("--file <path>", "Path to ModelProfilesDocument JSON file")
    .option("--json", "Output JSON")
    .action(async (options: { file?: string; json?: boolean }) => {
      const parsed = await readJsonInput(options.file);
      const doc: ModelProfilesDocument = parseWithSchema(
        ModelProfilesDocumentSchema,
        parsed,
        "ModelProfilesDocument",
      );
      const { client } = await connectLocalEngine(env);
      const updated = await client.putModelProfiles(doc);
      if (options.json) {
        console.log(JSON.stringify(updated, null, 2));
        return;
      }
      console.log(`Updated ${updated.profiles.length} model profile(s).`);
    });

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

  const configCommand = program
    .command("config")
    .description("Manage global Engine settings and config bundles");

  configCommand
    .command("get")
    .description("Show global Engine settings")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const settings = await client.getSettings();
      if (options.json) {
        console.log(JSON.stringify(settings, null, 2));
        return;
      }
      console.log(formatSettings(settings));
    });

  configCommand
    .command("set")
    .description("Update global Engine settings")
    .option("--max-active-workers <n>", "Max concurrent active Workers per project")
    .option("--background-after-ms <n>", "Auto-background foreground commands after ms")
    .option("--router-context-tokens <n>", "Target Router context token budget")
    .option("--idle-hibernate-ms <n>", "Idle project hibernation timeout in ms (0 disables)")
    .option("--router-model <provider/modelId>", "Default Router model")
    .option("--worker-model <provider/modelId>", "Default Worker model")
    .option("--dreamer-model <provider/modelId>", "Default Dreamer model")
    .option("--json", "Output JSON")
    .action(
      async (options: {
        maxActiveWorkers?: string;
        backgroundAfterMs?: string;
        routerContextTokens?: string;
        idleHibernateMs?: string;
        routerModel?: string;
        workerModel?: string;
        dreamerModel?: string;
        json?: boolean;
      }) => {
        const models: ModelSlotsOverride = {
          ...(options.routerModel === undefined
            ? {}
            : { router: parseModelFlag(options.routerModel, "--router-model") }),
          ...(options.workerModel === undefined
            ? {}
            : { worker: parseModelFlag(options.workerModel, "--worker-model") }),
          ...(options.dreamerModel === undefined
            ? {}
            : { dreamer: parseModelFlag(options.dreamerModel, "--dreamer-model") }),
        };
        const hasModels =
          models.router !== undefined ||
          models.worker !== undefined ||
          models.dreamer !== undefined;

        const patch: EngineSettings = {
          ...(options.maxActiveWorkers === undefined
            ? {}
            : {
                maxActiveWorkers: parseNonNegativeIntFlag(
                  options.maxActiveWorkers,
                  "--max-active-workers",
                ),
              }),
          ...(options.backgroundAfterMs === undefined
            ? {}
            : {
                backgroundAfterMs: parseNonNegativeIntFlag(
                  options.backgroundAfterMs,
                  "--background-after-ms",
                ),
              }),
          ...(options.routerContextTokens === undefined
            ? {}
            : {
                routerContextTokens: parsePositiveIntFlag(
                  options.routerContextTokens,
                  "--router-context-tokens",
                ),
              }),
          ...(options.idleHibernateMs === undefined
            ? {}
            : {
                idleHibernateMs: parseNonNegativeIntFlag(
                  options.idleHibernateMs,
                  "--idle-hibernate-ms",
                ),
              }),
          ...(hasModels ? { models } : {}),
        };

        if (Object.keys(patch).length === 0) {
          throw new Error("Specify at least one setting option to update.");
        }

        const { client } = await connectLocalEngine(env);
        const settings = await client.patchSettings(patch);
        if (options.json) {
          console.log(JSON.stringify(settings, null, 2));
          return;
        }
        console.log(formatSettings(settings));
      },
    );

  configCommand
    .command("export")
    .description("Export Engine settings, profiles, MCP servers, and models.json")
    .option("--file <path>", "Write exported config bundle to a file")
    .option("--json", "Output JSON")
    .action(async (options: { file?: string; json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const bundle = await client.exportConfig();
      const text = `${JSON.stringify(bundle, null, 2)}\n`;
      if (options.file !== undefined) {
        await writeFile(resolve(options.file), text, "utf8");
        if (options.json) {
          console.log(JSON.stringify(bundle, null, 2));
        } else {
          console.log(`Exported configuration to ${resolve(options.file)}`);
        }
        return;
      }
      process.stdout.write(text);
    });

  configCommand
    .command("import")
    .description("Import an exported config bundle from a JSON file or stdin")
    .option("--file <path>", "Path to exported config bundle JSON file")
    .option("--json", "Output JSON")
    .action(async (options: { file?: string; json?: boolean }) => {
      const parsed = await readJsonInput(options.file);
      const bundle = parseWithSchema(ConfigBundleSchema, parsed, "ConfigBundle");
      const { client } = await connectLocalEngine(env);
      const applied = await client.importConfig(bundle);
      if (options.json) {
        console.log(JSON.stringify(applied, null, 2));
        return;
      }
      console.log("Imported configuration bundle.");
    });

  program
    .command("send")
    .description("Send a message to a project's Router or Worker")
    .argument("<project>", "Project ID")
    .argument("<text>", "Message text")
    .option("--worker <wN>", "Target Worker ID (defaults to router)")
    .option("--when-busy <mode>", "Busy behavior: steer, followUp, or reject")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        text: string,
        options: { worker?: string; whenBusy?: string; json?: boolean },
      ) => {
        const ref: ConversationRef =
          options.worker === undefined
            ? "router"
            : parseWithSchema(WorkerIdSchema, options.worker, "--worker");
        let whenBusy: WhenBusy | undefined;
        if (options.whenBusy !== undefined) {
          whenBusy = parseWithSchema(WhenBusySchema, options.whenBusy, "--when-busy");
        }
        const { client } = await connectLocalEngine(env);
        const response = await client.sendMessage(projectId, ref, {
          text,
          ...(whenBusy === undefined ? {} : { whenBusy }),
        });
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(`Sent submission ${response.submissionId} (${response.status})`);
      },
    );

  program
    .command("board")
    .description("Inspect a project's Workers, Tickets, and Questions")
    .argument("<project>", "Project ID")
    .option("--watch", "Stream live Board updates")
    .option("--json", "Output JSON")
    .action(async (projectId: string, options: { watch?: boolean; json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      if (!options.watch) {
        const board = await client.getBoard(projectId);
        if (options.json) {
          console.log(JSON.stringify(board, null, 2));
          return;
        }
        console.log(formatBoard(board));
        return;
      }

      const controller = new AbortController();
      const cleanup = installSignalAbort(controller);
      try {
        for await (const event of client.streamBoard(projectId, { signal: controller.signal })) {
          if (event.type === "board") {
            if (options.json) {
              console.log(JSON.stringify(event.board));
            } else {
              console.log(formatBoard(event.board));
              console.log("---");
            }
          } else if (event.type === "end") {
            break;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        cleanup();
      }
    });

  program
    .command("watch")
    .description("Stream a project's Router or Worker conversation")
    .argument("<project>", "Project ID")
    .argument("[ref]", "Conversation target (router or wN)", "router")
    .option("--from <entryId>", "Resume from entry ID (inclusive)")
    .option("--last-event-id <entryId>", "Resume strictly after event ID (Last-Event-ID)")
    .option("--json", "Output NDJSON stream events")
    .action(
      async (
        projectId: string,
        rawRef: string,
        options: { from?: string; lastEventId?: string; json?: boolean },
      ) => {
        const ref = parseConversationRefArg(rawRef);
        const from =
          options.from === undefined ? undefined : parsePositiveIntFlag(options.from, "--from");
        const lastEventId =
          options.lastEventId === undefined
            ? undefined
            : parsePositiveIntFlag(options.lastEventId, "--last-event-id");
        const { client } = await connectLocalEngine(env);
        const controller = new AbortController();
        const cleanup = installSignalAbort(controller);
        const renderer = new ConversationWatchRenderer((chunk) => {
          process.stdout.write(chunk);
        });

        try {
          for await (const event of client.streamConversation(projectId, ref, {
            ...(from === undefined ? {} : { from }),
            ...(lastEventId === undefined ? {} : { lastEventId }),
            signal: controller.signal,
          })) {
            if (options.json) {
              process.stdout.write(`${JSON.stringify(event)}\n`);
              if (event.type === "end") break;
              continue;
            }
            if (event.type === "snapshot") {
              renderer.onSnapshot(event.view);
            } else if (event.type === "patch") {
              renderer.onPatch(event.view);
            } else if (event.type === "failed") {
              renderer.onFailed(event.message);
            } else if (event.type === "end") {
              renderer.onEnd();
              break;
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          cleanup();
        }
      },
    );

  program
    .command("answer")
    .description("Answer a pending Router question")
    .argument("<project>", "Project ID")
    .argument("<questionId>", "Question ID (e.g. q1)")
    .argument("<answers...>", "Answer(s) in question order")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        rawQuestionId: string,
        answers: string[],
        options: { json?: boolean },
      ) => {
        const questionId = parseWithSchema(QuestionIdSchema, rawQuestionId, "questionId");
        const { client } = await connectLocalEngine(env);
        const response = await client.answerQuestion(projectId, questionId, { answers });
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(formatQuestionAnswered(response));
      },
    );

  program
    .command("interrupt")
    .description("Interrupt a running Router or Worker conversation")
    .argument("<project>", "Project ID")
    .argument("[ref]", "Conversation target (router or wN)", "router")
    .option("--json", "Output JSON")
    .action(async (projectId: string, rawRef: string, options: { json?: boolean }) => {
      const ref = parseConversationRefArg(rawRef);
      const { client } = await connectLocalEngine(env);
      const response = await client.interrupt(projectId, ref);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(`Interrupted ${ref}`);
    });

  program
    .command("retry")
    .description("Retry or continue an idle Router or Worker conversation")
    .argument("<project>", "Project ID")
    .argument("[ref]", "Conversation target (router or wN)", "router")
    .option("--json", "Output JSON")
    .action(async (projectId: string, rawRef: string, options: { json?: boolean }) => {
      const ref = parseConversationRefArg(rawRef);
      const { client } = await connectLocalEngine(env);
      const response = await client.retry(projectId, ref);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(`Retried ${ref} (submission ${response.submissionId}, ${response.status})`);
    });

  const taskCommand = program
    .command("task")
    .description("Inspect and control Worker background tasks");

  taskCommand
    .command("read")
    .description("Read output from a Worker background task")
    .argument("<project>", "Project ID")
    .argument("<worker>", "Worker ID (e.g. w1)")
    .argument("<taskId>", "Task ID (e.g. task-1)")
    .option("--mode <mode>", "Read mode: head or tail")
    .option("--bytes <n>", "Max bytes to read")
    .option("--since-bytes <n>", "Read output starting from byte offset")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        rawWorker: string,
        rawTaskId: string,
        options: { mode?: string; bytes?: string; sinceBytes?: string; json?: boolean },
      ) => {
        const workerId = parseWithSchema(WorkerIdSchema, rawWorker, "worker");
        const taskId = parseNonEmptyTaskId(rawTaskId);
        let mode: TaskReadMode | undefined;
        if (options.mode !== undefined) {
          mode = parseWithSchema(TaskReadModeSchema, options.mode, "--mode");
        }
        const bytes =
          options.bytes === undefined ? undefined : parsePositiveIntFlag(options.bytes, "--bytes");
        const sinceBytes =
          options.sinceBytes === undefined
            ? undefined
            : parseNonNegativeIntFlag(options.sinceBytes, "--since-bytes");

        const { client } = await connectLocalEngine(env);
        const response = await client.readWorkerTask(projectId, workerId, taskId, {
          ...(mode === undefined ? {} : { mode }),
          ...(bytes === undefined ? {} : { bytes }),
          ...(sinceBytes === undefined ? {} : { sinceBytes }),
        });
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(formatTaskOutput(workerId, response));
      },
    );

  taskCommand
    .command("kill")
    .description("Kill a running Worker background task")
    .argument("<project>", "Project ID")
    .argument("<worker>", "Worker ID (e.g. w1)")
    .argument("<taskId>", "Task ID (e.g. task-1)")
    .option("--json", "Output JSON")
    .action(
      async (
        projectId: string,
        rawWorker: string,
        rawTaskId: string,
        options: { json?: boolean },
      ) => {
        const workerId = parseWithSchema(WorkerIdSchema, rawWorker, "worker");
        const taskId = parseNonEmptyTaskId(rawTaskId);
        const { client } = await connectLocalEngine(env);
        const response = await client.killWorkerTask(projectId, workerId, taskId);
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(
          `Killed task ${response.task.id} on ${workerId} (status: ${response.task.status})`,
        );
      },
    );

  return program;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
