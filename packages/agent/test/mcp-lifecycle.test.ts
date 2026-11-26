import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Conversation, ToolRegistration } from "@earendil-works/pi-durable";
import {
  LATEST_PROTOCOL_VERSION,
  type Tool as McpTool,
  type McpTransport,
  PipeTransport,
} from "@earendil-works/pi-mcp";
import {
  createMcpHub,
  getMcpServerExtensionRoles,
  isMcpServerEnabledForRole,
  type McpServerEntry,
  McpServerLog,
  mcpServerExtensionName,
  validateMcpServerEntry,
} from "../src/extensions/mcp/index.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";
import { createTestHarness, extractText } from "./harness.ts";

class LifecycleFakeMcpServer {
  tools: McpTool[];
  instructions?: string;
  hangInitialize = false;
  failToolsList = false;
  rootsChangedCount = 0;
  readonly encoder = new TextEncoder();
  readonly decoder = new TextDecoder();
  private link?: {
    readonly onStdout: (bytes: Uint8Array) => void;
    readonly finish: () => void;
    buffer: string;
    closed: boolean;
    nextReqId: number;
    pendingRequests: Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>;
  };

  constructor(tools: McpTool[] = [], options: { instructions?: string } = {}) {
    this.tools = [...tools];
    this.instructions = options.instructions;
  }

  createTransport(): McpTransport {
    return new PipeTransport({
      closeTimeoutMs: 20,
      open: async (handlers) => {
        let finish = () => {};
        const exited = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const link = {
          onStdout: handlers.onStdout,
          finish,
          buffer: "",
          closed: false,
          nextReqId: 100,
          pendingRequests: new Map<
            number,
            { resolve: (val: unknown) => void; reject: (err: Error) => void }
          >(),
        };
        this.link = link;
        const close = () => {
          if (link.closed) return;
          link.closed = true;
          for (const pending of link.pendingRequests.values()) {
            pending.reject(new Error("closed"));
          }
          link.pendingRequests.clear();
          if (this.link === link) this.link = undefined;
          queueMicrotask(link.finish);
        };
        return {
          write: (data) => {
            if (link.closed) return;
            link.buffer +=
              typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
            for (;;) {
              const nl = link.buffer.indexOf("\n");
              if (nl < 0) return;
              const raw = link.buffer.slice(0, nl).trim();
              link.buffer = link.buffer.slice(nl + 1);
              if (raw) this.handleMessage(link, JSON.parse(raw) as Record<string, unknown>);
            }
          },
          closeStdin: close,
          close,
          exited,
        };
      },
    });
  }

  pushToolsChanged(): void {
    if (this.link && !this.link.closed) {
      this.send(this.link, { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
  }

  pushLog(level: string, logger: string, data: unknown): void {
    if (this.link && !this.link.closed) {
      this.send(this.link, {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level, logger, data },
      });
    }
  }

  async requestRoots(): Promise<{ roots: { uri: string; name?: string }[] }> {
    const link = this.link;
    if (!link || link.closed) throw new Error("Not connected");
    const id = link.nextReqId++;
    return new Promise((resolve, reject) => {
      link.pendingRequests.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
      });
      this.send(link, { jsonrpc: "2.0", id, method: "roots/list" });
    });
  }

  private send(
    link: NonNullable<LifecycleFakeMcpServer["link"]>,
    msg: Record<string, unknown>,
  ): void {
    if (!link.closed) link.onStdout(this.encoder.encode(`${JSON.stringify(msg)}\n`));
  }

  private handleMessage(
    link: NonNullable<LifecycleFakeMcpServer["link"]>,
    msg: Record<string, unknown>,
  ): void {
    if (!("method" in msg) && "id" in msg && typeof msg.id === "number") {
      const pending = link.pendingRequests.get(msg.id);
      if (pending) {
        link.pendingRequests.delete(msg.id);
        if ("error" in msg) pending.reject(new Error(JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
      return;
    }
    if (!("id" in msg)) {
      if (msg.method === "notifications/roots/list_changed") {
        this.rootsChangedCount += 1;
      }
      return;
    }
    const id = msg.id;
    const method = msg.method;
    if (method === "initialize") {
      if (this.hangInitialize) return;
      this.send(link, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true }, logging: {} },
          serverInfo: { name: "lifecycle-fake", version: "1.0.0" },
          ...(this.instructions === undefined ? {} : { instructions: this.instructions }),
        },
      });
      return;
    }
    if (method === "tools/list") {
      if (this.failToolsList) {
        this.send(link, {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "tools/list temporarily broken" },
        });
        return;
      }
      this.send(link, { jsonrpc: "2.0", id, result: { tools: this.tools } });
      return;
    }
    if (method === "tools/call") {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      this.send(link, {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `called:${params.name}` }] },
      });
      return;
    }
    this.send(link, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    });
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function toolResults(conversation: Conversation) {
  const entries = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
  const out: { toolName?: string; isError?: boolean; content?: unknown }[] = [];
  for (const entry of entries.items) {
    if (entry.kind !== "pi.tool-result") continue;
    const model = (entry as { model?: unknown[] }).model;
    if (Array.isArray(model) && model[0]) {
      out.push(model[0] as { toolName?: string; isError?: boolean; content?: unknown });
    }
  }
  return out;
}

test("startBackground does not block and ensureServerReady isolates fast server from slow sibling", async () => {
  const fast = new LifecycleFakeMcpServer([
    { name: "ping", description: "Fast ping", inputSchema: { type: "object", properties: {} } },
  ]);
  const slow = new LifecycleFakeMcpServer([
    { name: "hang", description: "Slow hang", inputSchema: { type: "object", properties: {} } },
  ]);
  slow.hangInitialize = true;

  const hub = createMcpHub({
    servers: [
      { name: "fast", config: { command: "fast", exposure: "direct" } },
      { name: "slow", config: { command: "slow", exposure: "direct" } },
    ],
    createTransport: (entry) =>
      entry.name === "fast" ? fast.createTransport() : slow.createTransport(),
  });

  try {
    const startMs = Date.now();
    hub.startBackground();
    assert.ok(Date.now() - startMs < 100, "startBackground must return immediately");

    await hub.ensureServerReady("fast");
    assert.equal(hub.status().find((s) => s.name === "fast")?.status, "connected");
    assert.equal(hub.status().find((s) => s.name === "slow")?.status, "connecting");

    const fastExt = hub
      .serverExtensions()
      .find((ext) => ext.name === mcpServerExtensionName("fast"));
    const ping = fastExt?.tools?.find((t) => t.name === "mcp__fast__ping") as ToolRegistration;
    const result = await ping.execute({}, {} as never, BACKGROUND_CONTEXT);
    assert.equal("isError" in result ? result.isError : undefined, undefined);

    await assert.rejects(
      hub.ensureServerReady("slow", 40),
      /Timed out waiting 40ms for MCP server "slow"/,
    );
    assert.equal(hub.status().find((s) => s.name === "slow")?.status, "connecting");
  } finally {
    await hub.close();
  }
});

test("HTTP connect retries once on transient 5xx while tool calls never retry", async () => {
  let initAttempts = 0;
  let toolAttempts = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (!("id" in msg)) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === "initialize") {
        initAttempts += 1;
        if (initAttempts === 1) {
          res.writeHead(503);
          res.end("booting");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "flaky-http", version: "1.0.0" },
            },
          }),
        );
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "mutate",
                  description: "Non-idempotent action",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          }),
        );
        return;
      }
      if (msg.method === "tools/call") {
        toolAttempts += 1;
        res.writeHead(503);
        res.end("downstream failed");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("Expected TCP address");

  const hub = createMcpHub({
    servers: [
      {
        name: "flakyhttp",
        config: { type: "http", url: `http://127.0.0.1:${addr.port}/mcp`, exposure: "direct" },
      },
    ],
    transientRetryDelayMs: 10,
  });

  try {
    await hub.start();
    assert.equal(initAttempts, 2);
    assert.equal(hub.status()[0]?.status, "connected");

    const mutate = hub
      .serverExtensions()[0]
      ?.tools?.find((t) => t.name === "mcp__flakyhttp__mutate");
    assert.ok(mutate);
    const callRes = await mutate.execute({}, {} as never, BACKGROUND_CONTEXT);
    assert.equal("isError" in callRes ? callRes.isError : undefined, true);
    assert.equal(toolAttempts, 1);
  } finally {
    await hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("multi-path roots are served to clients and updateRoots broadcasts list_changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-mcp-roots-"));
  const ws1 = join(dir, "workspace-one");
  const ws2 = join(dir, "workspace-two");
  const ws3 = join(dir, "workspace-three");
  await Promise.all([
    mkdir(ws1, { recursive: true }),
    mkdir(ws2, { recursive: true }),
    mkdir(ws3, { recursive: true }),
  ]);

  const srv = new LifecycleFakeMcpServer();
  const hub = createMcpHub({
    servers: [{ name: "rootsrv", config: { command: "fake" } }],
    roots: [ws1, ws2],
    createTransport: () => srv.createTransport(),
  });

  try {
    await hub.start();
    const initial = await srv.requestRoots();
    assert.deepEqual(initial.roots, [
      { uri: pathToFileURL(ws1).href, name: basename(ws1) },
      { uri: pathToFileURL(ws2).href, name: basename(ws2) },
    ]);
    assert.equal(srv.rootsChangedCount, 0);

    await hub.updateRoots([ws2, ws3]);
    await waitFor(() => srv.rootsChangedCount === 1, "roots list_changed notification");
    const updated = await srv.requestRoots();
    assert.deepEqual(updated.roots, [
      { uri: pathToFileURL(ws2).href, name: basename(ws2) },
      { uri: pathToFileURL(ws3).href, name: basename(ws3) },
    ]);
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("McpServerLog rotates files, caps ring buffers, and McpHub captures stdio stderr and notifications/message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-mcp-logs-"));
  try {
    // Unit test rotation and ring bounds
    const unitLogPath = join(dir, "unit.log");
    const unitLog = new McpServerLog({
      logPath: unitLogPath,
      maxFileBytes: 120,
      maxLinesPerServer: 4,
      maxBytesPerServer: 220,
    });
    unitLog.recordStderr("s1", "partial ");
    unitLog.recordStderr("s1", "line one\nline two\n");
    for (let i = 3; i <= 7; i += 1) {
      unitLog.recordNotification("s1", { level: "warning", logger: "core", data: `msg-${i}` });
    }
    await unitLog.close();
    const ring = unitLog.getServerLogs("s1");
    assert.equal(ring.length, 4);
    assert.ok(ring.at(-1)?.includes("core: msg-7"));
    const rotatedText = await readFile(`${unitLogPath}.1`, "utf8");
    assert.ok(rotatedText.includes("[s1]"));

    // Real stdio server emitting stderr & notifications/message
    const script = [
      'const readline = require("node:readline");',
      'process.stderr.write("stdio boot diagnostic\\n");',
      "const rl = readline.createInterface({ input: process.stdin });",
      'rl.on("line", (line) => {',
      "  if (!line.trim()) return;",
      "  const msg = JSON.parse(line);",
      '  if (msg.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {}, logging: {} }, serverInfo: { name: "stdio-log", version: "1.0.0" } } }) + "\\n");',
      '  } else if (msg.method === "notifications/initialized") {',
      '    process.stderr.write("stdio ready stderr\\n");',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", logger: "srv", data: "hello from notification" } }) + "\\n");',
      '  } else if (msg.method === "tools/list") {',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");',
      "  }",
      "});",
    ].join("\n");

    const hubLogPath = join(dir, "logs", "mcp.log");
    const hub = createMcpHub({
      logPath: hubLogPath,
      servers: [
        {
          name: "stdiolog",
          config: { command: process.execPath, args: ["-e", script] },
        },
      ],
    });
    try {
      await hub.start();
      await waitFor(() => {
        const logs = hub.getServerLogs("stdiolog");
        return (
          logs.some((l) => l.includes("stdio boot diagnostic")) &&
          logs.some((l) => l.includes("hello from notification"))
        );
      }, "stdio stderr and notification logs");

      const snap = hub.status()[0];
      assert.equal(snap?.transport, "stdio");
      assert.ok(snap?.recentLogs?.some((l) => l.includes("stdio ready stderr")));
    } finally {
      await hub.close();
    }
    const diskLog = await readFile(hubLogPath, "utf8");
    assert.ok(diskLog.includes("[stdiolog] [stderr] stdio boot diagnostic"));
    assert.ok(diskLog.includes("[stdiolog] [mcp:info] srv: hello from notification"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("roles config validation, extension role metadata, and degraded refresh transitions", async () => {
  const valid = validateMcpServerEntry("worker-only", {
    command: "run",
    roles: { router: false, worker: true },
  });
  assert.notEqual(typeof valid, "string");
  if (typeof valid !== "string") {
    assert.equal(isMcpServerEnabledForRole(valid, "router"), false);
    assert.equal(isMcpServerEnabledForRole(valid, "worker"), true);
  }

  assert.match(
    String(validateMcpServerEntry("bad1", { command: "x", roles: "router" })),
    /roles must be an object/,
  );
  assert.match(
    String(validateMcpServerEntry("bad2", { command: "x", roles: { router: "no" } })),
    /roles\.router must be a boolean/,
  );
  assert.match(
    String(validateMcpServerEntry("bad3", { command: "x", roles: { dreamer: true } })),
    /unknown key "dreamer"/,
  );

  const srv = new LifecycleFakeMcpServer([
    { name: "act", description: "Act", inputSchema: { type: "object", properties: {} } },
  ]);
  const hub = createMcpHub({
    servers: [
      {
        name: "worker-only",
        config: { command: "fake", roles: { router: false, worker: true } },
      },
    ],
    createTransport: () => srv.createTransport(),
  });
  try {
    await hub.start();
    const snap = hub.status()[0];
    assert.deepEqual(snap?.roles, { router: false, worker: true });
    assert.equal(snap?.exposure, "codemode");
    assert.equal(snap?.tools?.[0]?.exposure, "codemode");

    const ext = hub.serverExtensions()[0];
    assert.ok(ext);
    assert.deepEqual(getMcpServerExtensionRoles(ext), { router: false, worker: true });

    // Trigger degraded state when tools/list fails on live refresh, then recover
    srv.failToolsList = true;
    srv.pushToolsChanged();
    await waitFor(() => hub.status()[0]?.status === "degraded", "degraded status");
    assert.match(hub.status()[0]?.error ?? "", /Failed to refresh tools/);

    srv.failToolsList = false;
    srv.pushToolsChanged();
    await waitFor(() => hub.status()[0]?.status === "connected", "recovered connected status");
    assert.equal(hub.status()[0]?.error, undefined);
  } finally {
    await hub.close();
  }
});

test("tool_search discovers deferred MCP tools via server namespace description and instructions", async () => {
  const srv = new LifecycleFakeMcpServer(
    [
      {
        name: "run_action",
        description: "Execute a remote command",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Target identifier" } },
          required: ["id"],
        },
      },
    ],
    { instructions: "Use this integration for octocat workflows and deployment checks." },
  );
  const entry: McpServerEntry = {
    name: "github",
    config: {
      command: "fake",
      description: "GitHub repositories and pull requests",
      exposure: "deferred",
    },
  };
  const hub = createMcpHub({
    servers: [entry],
    createTransport: () => srv.createTransport(),
  });
  const th = await createTestHarness({ extensions: [createToolSearchExtension()] });
  const unbind = hub.bindRegistry(th.registry);

  try {
    await hub.start();
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "octocat pull requests" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("mcp__github__run_action", { id: "pr-42" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const conversation = await th.createConversation({ extensions: null });
    const sub = await conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
    await sub.wait(BACKGROUND_CONTEXT);

    const results = await toolResults(conversation);
    const search = results.find((r) => r.toolName === "tool_search");
    assert.equal(search?.isError, false);
    assert.ok(extractText(search?.content).includes("mcp__github__run_action"));

    const mcpCall = results.find((r) => r.toolName === "mcp__github__run_action");
    assert.equal(mcpCall?.isError, false);
    assert.ok(extractText(mcpCall?.content).includes("called:run_action"));
  } finally {
    unbind();
    await hub.close();
    await th.cleanup();
  }
});
