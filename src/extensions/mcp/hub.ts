import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import {
  McpClient,
  type McpOutputSaver,
  type McpTransport,
  mcpNamespace,
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import {
  type ConfigIssue,
  type ConfigProblem,
  describeConfigIssue,
  describeConfigProblem,
} from "../../contracts/index.ts";
import { ConfigError, configIssue, processEnv, resolveConfigValue } from "../../shared/config.ts";
import { scrubbedEnv } from "../../shared/env.ts";
import { bridgeTools } from "./bridge.ts";
import {
  loadMcpConfig,
  type McpExposure,
  type McpServerEntry,
  mcpExtensionName,
  readMcpEntries,
  writeMcpEntry,
} from "./config.ts";

export type McpServerState = "disabled" | "connecting" | "connected" | "failed";

export type McpServerStatus = {
  name: string;
  extension: string;
  state: McpServerState;
  exposure: McpExposure;
  tools: number;
  error?: ConfigIssue;
};

export type McpHubOptions = {
  configPath: string;
  /** Where the full text of outputs cut to fit the model goes. */
  outputDir: string;
  client: { name: string; version: string };
  /** Called whenever a server's extension or state changes. */
  onChange(): void;
  /** Opens a server's transport; tests pass an in-memory one. */
  open?(
    entry: McpServerEntry,
    onStderr: (chunk: string) => void,
  ): McpTransport | Promise<McpTransport>;
};

type Connection = {
  entry: McpServerEntry;
  state: McpServerState;
  error?: ConfigIssue;
  client?: McpClient;
  summary: string;
  tools: number;
  extension: Extension;
};

const STDERR_TAIL = 2000;

/**
 * The Engine's MCP servers: one connection per configured server, shared by every project, each offered as
 * the extension `mcp.<name>`. Servers connect in the background; an extension has no tools until its server
 * answered, and loses them when the connection drops. `reload()` reads mcp.json again and reconnects;
 * `save()` changes one server's entry and reconnects just that one. A connection that is no longer the
 * server's current one is closed as soon as it answers.
 */
export class McpHub {
  readonly #options: McpHubOptions;
  readonly #connections = new Map<string, Connection>();
  #problems: readonly ConfigProblem[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: McpHubOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    const { servers, problems } = await loadMcpConfig(this.#options.configPath);
    this.#problems = problems;
    for (const problem of problems) console.error(describeConfigProblem(problem));
    for (const entry of servers) this.#open(entry);
    this.#options.onChange();
  }

  /** The server entries of mcp.json as written. */
  entries(): Promise<Record<string, unknown>> {
    return this.#serial(() => readMcpEntries(this.#options.configPath));
  }

  /**
   * Writes one server's entry, or removes it (`undefined`), then reconnects that server alone; the others
   * keep their connections.
   */
  save(name: string, entry: Record<string, unknown> | undefined): Promise<void> {
    return this.#serial(async () => {
      await writeMcpEntry(this.#options.configPath, name, entry);
      const { servers, problems } = await loadMcpConfig(this.#options.configPath);
      this.#problems = problems;
      const old = this.#connections.get(name);
      this.#connections.delete(name);
      await old?.client?.close().catch(() => undefined);
      const fresh = servers.find((s) => s.name === name);
      if (fresh !== undefined) this.#open(fresh);
      this.#options.onChange();
    });
  }

  /** Extensions of the enabled servers, connected or not, so roles can name them either way. */
  extensions(): Extension[] {
    return [...this.#connections.values()]
      .filter((c) => c.state !== "disabled")
      .map((c) => c.extension);
  }

  /** Code mode groups: one per connected server, by its tool name prefix. */
  namespaces(): CodemodeNamespace[] {
    return [...this.#connections.values()]
      .filter((c) => c.state === "connected")
      .map((c) => ({
        name: mcpNamespace(c.entry.name),
        prefix: `${mcpNamespace(c.entry.name)}__`,
        ...(c.summary ? { description: c.summary } : {}),
      }));
  }

  status(): McpServerStatus[] {
    return [...this.#connections.values()].map((c) => ({
      name: c.entry.name,
      extension: mcpExtensionName(c.entry.name),
      state: c.state,
      exposure: c.entry.exposure,
      tools: c.tools,
      ...(c.error === undefined ? {} : { error: c.error }),
    }));
  }

  problems(): readonly ConfigProblem[] {
    return this.#problems;
  }

  reload(): Promise<void> {
    return this.#serial(async () => {
      await this.#closeAll();
      await this.start();
    });
  }

  async close(): Promise<void> {
    await this.#closeAll();
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #open(entry: McpServerEntry): void {
    const connection: Connection = {
      entry,
      state: entry.enabled ? "connecting" : "disabled",
      summary: entry.description ?? "",
      tools: 0,
      extension: defineExtension({ name: mcpExtensionName(entry.name) }),
    };
    this.#connections.set(entry.name, connection);
    if (entry.enabled) void this.#connect(connection);
  }

  #current(connection: Connection): boolean {
    return this.#connections.get(connection.entry.name) === connection;
  }

  async #closeAll(): Promise<void> {
    const clients = [...this.#connections.values()].flatMap((c) => (c.client ? [c.client] : []));
    this.#connections.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }

  async #connect(connection: Connection): Promise<void> {
    const { entry } = connection;
    const client = new McpClient({ ...this.#options.client });
    let stderr = "";
    try {
      const transport = await (this.#options.open ?? openTransport)(entry, (chunk) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL);
      });
      await client.connect(transport);
      const tools = await client.listTools(
        entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs },
      );
      if (!this.#current(connection)) {
        await client.close();
        return;
      }
      connection.client = client;
      connection.state = "connected";
      connection.summary = summaryOf(entry.description, client.instructions);
      const bridged = bridgeTools(entry.name, client, tools, {
        exposure: entry.exposure,
        saveOutput: this.#saveOutput,
        ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
      });
      connection.tools = bridged.length;
      connection.extension = defineExtension({
        name: mcpExtensionName(entry.name),
        tools: bridged,
      });
      client.onClose(() => {
        if (connection.client !== client || !this.#current(connection)) return;
        this.#drop(connection, { code: "disconnected" });
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      if (!this.#current(connection)) return;
      const issue = configIssue(error);
      connection.state = "failed";
      connection.error =
        issue.code === "failed" && stderr.trim()
          ? { ...issue, detail: `${issue.detail}\n${stderr.trim()}` }
          : issue;
      console.error(
        `[mcp] ${entry.name} failed to connect: ${describeConfigIssue(connection.error)}`,
      );
    }
    this.#options.onChange();
  }

  #drop(connection: Connection, reason: ConfigIssue): void {
    connection.state = "failed";
    connection.error = reason;
    delete connection.client;
    connection.tools = 0;
    connection.extension = defineExtension({ name: mcpExtensionName(connection.entry.name) });
    this.#options.onChange();
  }

  readonly #saveOutput: McpOutputSaver = async (data, extension) => {
    await mkdir(this.#options.outputDir, { recursive: true });
    const path = join(this.#options.outputDir, `${randomUUID()}.${extension}`);
    await writeFile(path, data);
    return path;
  };
}

/** The first line of the configured description, else of the instructions the server sent. */
function summaryOf(description: string | undefined, instructions: string | undefined): string {
  const text = description?.trim() || instructions?.trim() || "";
  return (text.split("\n", 1)[0] ?? "").trim();
}

async function openTransport(
  entry: McpServerEntry,
  onStderr: (chunk: string) => void,
): Promise<McpTransport> {
  if (entry.kind === "http") {
    return new StreamableHttpTransport({
      url: entry.config.url,
      ...(entry.config.headers === undefined
        ? {}
        : { headers: await resolveAll(entry.config.headers, entry.name) }),
    });
  }
  const { command, args, cwd, env } = entry.config;
  return new StdioTransport({
    command,
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...scrubbedEnv(), ...(env === undefined ? {} : await resolveAll(env, entry.name)) },
    inheritEnv: false,
    stderr: "pipe",
    onStderr,
  });
}

async function resolveAll(
  values: Record<string, string>,
  server: string,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    const value = await resolveConfigValue(raw, processEnv);
    if (value === undefined) {
      throw new ConfigError([{ file: "mcp.json", entry: server, code: "env_unset", name: key }]);
    }
    resolved[key] = value;
  }
  return resolved;
}
