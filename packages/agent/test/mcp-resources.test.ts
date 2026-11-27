import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import {
  type Conversation,
  type Extension,
  hook,
  type ToolExecutionResult,
  ToolTask,
} from "@earendil-works/pi-durable";
import {
  LATEST_PROTOCOL_VERSION,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type McpTransport,
  PipeTransport,
  type ReadResourceResult,
} from "@earendil-works/pi-mcp";
import { createCodemodeExtension } from "../src/extensions/codemode/index.ts";
import {
  createMcpHub,
  getMcpServerExtensionRoles,
  LIST_MCP_RESOURCE_TEMPLATES_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
  MCP_EXTENSION,
  type McpHub,
  type McpServerEntry,
  READ_MCP_RESOURCE_TOOL_NAME,
} from "../src/extensions/mcp/index.ts";
import { createTestHarness, extractText } from "./harness.ts";

class FakeResourceMcpServer {
  resourcesPages: Record<string, ListResourcesResult> = {
    "": { resources: [] },
  };
  templatesPages: Record<string, ListResourceTemplatesResult> = {
    "": { resourceTemplates: [] },
  };
  readHandlers = new Map<string, () => ReadResourceResult>();
  advertiseResources = true;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  createTransport(): McpTransport {
    return new PipeTransport({
      closeTimeoutMs: 20,
      open: async (handlers) => {
        let buffer = "";
        let closed = false;
        let finish = () => {};
        const exited = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const send = (msg: Record<string, unknown>) => {
          if (!closed) handlers.onStdout(this.encoder.encode(`${JSON.stringify(msg)}\n`));
        };
        const close = () => {
          if (closed) return;
          closed = true;
          queueMicrotask(finish);
        };
        const handle = (msg: Record<string, unknown>) => {
          if (!("id" in msg)) return;
          const id = msg.id;
          const method = msg.method;
          const params = (
            typeof msg.params === "object" && msg.params !== null ? msg.params : {}
          ) as Record<string, unknown>;
          if (method === "initialize") {
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {
                  tools: {},
                  ...(this.advertiseResources ? { resources: {} } : {}),
                },
                serverInfo: { name: "fake-resource-mcp", version: "1.0.0" },
              },
            });
            return;
          }
          if (method === "tools/list") {
            send({ jsonrpc: "2.0", id, result: { tools: [] } });
            return;
          }
          if (method === "resources/list") {
            const cursor = typeof params.cursor === "string" ? params.cursor : "";
            const page = this.resourcesPages[cursor] ?? { resources: [] };
            send({ jsonrpc: "2.0", id, result: page });
            return;
          }
          if (method === "resources/templates/list") {
            const cursor = typeof params.cursor === "string" ? params.cursor : "";
            const page = this.templatesPages[cursor] ?? { resourceTemplates: [] };
            send({ jsonrpc: "2.0", id, result: page });
            return;
          }
          if (method === "resources/read") {
            const uri = typeof params.uri === "string" ? params.uri : "";
            const handler = this.readHandlers.get(uri);
            if (!handler) {
              send({ jsonrpc: "2.0", id, error: { code: -32002, message: `Not found: ${uri}` } });
              return;
            }
            send({ jsonrpc: "2.0", id, result: handler() });
            return;
          }
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${String(method)}` },
          });
        };

        return {
          write: (data) => {
            if (closed) return;
            buffer += typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
            for (;;) {
              const nl = buffer.indexOf("\n");
              if (nl < 0) return;
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (line) handle(JSON.parse(line) as Record<string, unknown>);
            }
          },
          closeStdin: close,
          close,
          exited,
        };
      },
    });
  }
}

async function toolResults(conversation: Conversation) {
  const entries = await conversation.entries({}, 300, undefined, BACKGROUND_CONTEXT);
  const results: { toolName?: string; isError?: boolean; content?: unknown; details?: unknown }[] =
    [];
  for (const entry of [...entries.items].reverse()) {
    if (entry.kind !== "pi.tool-result") continue;
    const model = (entry as { model?: unknown[] }).model;
    if (Array.isArray(model) && model[0]) {
      results.push(
        model[0] as { toolName?: string; isError?: boolean; content?: unknown; details?: unknown },
      );
    }
  }
  return results;
}

function captureExtension(captured: Map<string, ToolExecutionResult[]>): Extension {
  return {
    name: "test.capture",
    hooks: [
      hook(ToolTask, {
        afterTool: (call, result) => {
          const list = captured.get(call.name) ?? [];
          list.push(structuredClone(result) as ToolExecutionResult);
          captured.set(call.name, list);
        },
      }),
    ],
  };
}

function createResourceHub(
  servers: Readonly<Record<string, FakeResourceMcpServer>>,
  entries: readonly McpServerEntry[],
  saveDir?: string,
): McpHub {
  return createMcpHub({
    servers: entries,
    createTransport: (entry) => {
      const server = servers[entry.name];
      if (!server) throw new Error(`Missing fake server ${entry.name}`);
      return server.createTransport();
    },
    ...(saveDir === undefined
      ? {}
      : {
          saveOutput: async (data, ext) => {
            const { writeFile } = await import("node:fs/promises");
            const filePath = join(saveDir, `blob${ext}`);
            await writeFile(filePath, data);
            return filePath;
          },
        }),
  });
}

test("resource tools paginate, filter ui:// and profile=mcp-app, save binary blobs, and return structuredOutput", async () => {
  const saveDir = await mkdtemp(join(tmpdir(), "eevee-mcp-res-"));
  const docs = new FakeResourceMcpServer();
  docs.resourcesPages = {
    "": {
      resources: [
        {
          uri: "docs://guide",
          name: "guide",
          mimeType: "text/markdown",
          description: "User guide",
        },
        { uri: "ui://widget/panel", name: "panel", mimeType: "text/html" },
        { uri: "docs://app", name: "app", mimeType: "text/html; profile=mcp-app" },
      ],
      nextCursor: "page-2",
    },
    "page-2": {
      resources: [
        { uri: "docs://archive.bin", name: "archive", mimeType: "application/octet-stream" },
      ],
    },
  };
  docs.templatesPages = {
    "": {
      resourceTemplates: [
        { uriTemplate: "docs://item/{id}", name: "item", description: "Item by id" },
        { uriTemplate: "ui://template/{id}", name: "ui-tpl", mimeType: "text/html" },
      ],
      nextCursor: "tpl-2",
    },
    "tpl-2": {
      resourceTemplates: [{ uriTemplate: "docs://extra/{slug}", name: "extra" }],
    },
  };
  docs.readHandlers.set("docs://guide", () => ({
    contents: [{ uri: "docs://guide", mimeType: "text/markdown", text: "# Welcome Guide" }],
  }));
  docs.readHandlers.set("docs://archive.bin", () => ({
    contents: [
      {
        uri: "docs://archive.bin",
        mimeType: "application/octet-stream",
        blob: Buffer.from("RAW-BYTES-123").toString("base64"),
      },
    ],
  }));
  docs.readHandlers.set("docs://app", () => ({
    contents: [
      { uri: "docs://app", mimeType: "text/html; profile=mcp-app", text: "<div>ui</div>" },
    ],
  }));

  const hub = createResourceHub({ docs }, [{ name: "docs", config: { command: "fake" } }], saveDir);
  const captured = new Map<string, ToolExecutionResult[]>();
  const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
  const th = await createTestHarness({
    extensions: [captureExtension(captured), createCodemodeExtension({ sandbox, models: false })],
  });
  const unbind = hub.bindRegistry(th.registry);

  try {
    assert.equal(th.registry.snapshot().extension(MCP_EXTENSION)?.tools, undefined);

    await hub.start();
    assert.equal(hub.status()[0]?.hasResources, true);
    const mcpTools = th.registry.snapshot().extension(MCP_EXTENSION)?.tools ?? [];
    assert.deepEqual(mcpTools.map((t) => t.name).sort(), [
      LIST_MCP_RESOURCE_TEMPLATES_TOOL_NAME,
      LIST_MCP_RESOURCES_TOOL_NAME,
      READ_MCP_RESOURCE_TOOL_NAME,
    ]);

    const code = [
      'const p1 = await tools.list_mcp_resources({ server: "docs" });',
      'const p2 = await tools.list_mcp_resources({ server: "docs", cursor: p1.nextCursor });',
      'const t1 = await tools.list_mcp_resource_templates({ server: "docs" });',
      'const t2 = await tools.list_mcp_resource_templates({ server: "docs", cursor: t1.nextCursor });',
      'const guide = await tools.read_mcp_resource({ server: "docs", uri: "docs://guide" });',
      "return { p1, p2, t1, t2, guide };",
    ].join("\n");

    th.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall(READ_MCP_RESOURCE_TOOL_NAME, { server: "docs", uri: "docs://archive.bin" })],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage(
        [fauxToolCall(READ_MCP_RESOURCE_TOOL_NAME, { server: "docs", uri: "ui://widget/panel" })],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage(
        [fauxToolCall(READ_MCP_RESOURCE_TOOL_NAME, { server: "docs", uri: "docs://app" })],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    const conversation = await th.createConversation({ extensions: null });
    const sub = await conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
    await sub.wait(BACKGROUND_CONTEXT);

    const results = await toolResults(conversation);
    const readCalls = results.filter((r) => r.toolName === READ_MCP_RESOURCE_TOOL_NAME);
    assert.equal(readCalls.length, 3);

    const binaryText = extractText(readCalls[0]?.content);
    assert.ok(binaryText.includes("saved to"), `unexpected binaryText: ${binaryText}`);
    const savedPath = join(saveDir, "blob.bin");
    assert.equal(await readFile(savedPath, "utf8"), "RAW-BYTES-123");

    assert.equal(readCalls[1]?.isError, true);
    assert.equal(readCalls[2]?.isError, true);

    const codemode = results.find((r) => r.toolName === "codemode");
    assert.equal(codemode?.isError, false);
    const cmText = extractText(codemode?.content);
    const marker = "Output:\n";
    const payload = JSON.parse(cmText.slice(cmText.indexOf(marker) + marker.length).trim()) as {
      p1: { resources: { uri: string }[]; nextCursor?: string };
      p2: { resources: { uri: string }[]; nextCursor?: string };
      t1: { resourceTemplates: { uriTemplate: string }[]; nextCursor?: string };
      t2: { resourceTemplates: { uriTemplate: string }[]; nextCursor?: string };
      guide: { contents: { text?: string }[] };
    };
    assert.deepEqual(
      payload.p1.resources.map((r) => r.uri),
      ["docs://guide"],
    );
    assert.equal(payload.p1.nextCursor, "page-2");
    assert.deepEqual(
      payload.p2.resources.map((r) => r.uri),
      ["docs://archive.bin"],
    );
    assert.equal(payload.p2.nextCursor, undefined);
    assert.deepEqual(
      payload.t1.resourceTemplates.map((t) => t.uriTemplate),
      ["docs://item/{id}"],
    );
    assert.equal(payload.t1.nextCursor, "tpl-2");
    assert.deepEqual(
      payload.t2.resourceTemplates.map((t) => t.uriTemplate),
      ["docs://extra/{slug}"],
    );
    assert.equal(payload.guide.contents[0]?.text, "# Welcome Guide");
  } finally {
    unbind();
    await hub.close();
    await th.cleanup();
    await sandbox.close();
    await rm(saveDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("resource tools enforce conversation-scoped server visibility (Router cannot read Worker-only resources)", async () => {
  const pub = new FakeResourceMcpServer();
  pub.resourcesPages = { "": { resources: [{ uri: "pub://readme", name: "readme" }] } };
  pub.readHandlers.set("pub://readme", () => ({
    contents: [{ uri: "pub://readme", text: "public text" }],
  }));

  const priv = new FakeResourceMcpServer();
  priv.resourcesPages = { "": { resources: [{ uri: "priv://secret", name: "secret" }] } };
  priv.readHandlers.set("priv://secret", () => ({
    contents: [{ uri: "priv://secret", text: "worker secret" }],
  }));

  const hub = createResourceHub({ pub, priv }, [
    { name: "pub", config: { command: "fake" } },
    { name: "priv", config: { command: "fake", roles: { router: false, worker: true } } },
  ]);

  const captured = new Map<string, ToolExecutionResult[]>();
  const th = await createTestHarness({ extensions: [captureExtension(captured)] });
  const unbind = hub.bindRegistry(th.registry);

  try {
    await hub.start();

    const routerExts = th.registry
      .snapshot()
      .installed()
      .filter((ext) => {
        const roles = getMcpServerExtensionRoles(ext);
        return roles === undefined || roles.router;
      });
    const workerExts = th.registry
      .snapshot()
      .installed()
      .filter((ext) => {
        const roles = getMcpServerExtensionRoles(ext);
        return roles === undefined || roles.worker;
      });

    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall(LIST_MCP_RESOURCES_TOOL_NAME, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        [fauxToolCall(READ_MCP_RESOURCE_TOOL_NAME, { server: "priv", uri: "priv://secret" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("router-done"),
    ]);
    const routerConv = await th.createConversation({ extensions: routerExts });
    await (await routerConv.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );

    const routerList = captured.get(LIST_MCP_RESOURCES_TOOL_NAME)?.[0]?.structuredOutput as {
      resources: { server: string; uri: string }[];
    };
    assert.deepEqual(
      routerList.resources.map((r) => r.server),
      ["pub"],
    );
    const routerPrivRead = captured.get(READ_MCP_RESOURCE_TOOL_NAME)?.[0];
    assert.equal(routerPrivRead?.isError, true);

    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall(LIST_MCP_RESOURCES_TOOL_NAME, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        [fauxToolCall(READ_MCP_RESOURCE_TOOL_NAME, { server: "priv", uri: "priv://secret" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("worker-done"),
    ]);
    const workerConv = await th.createConversation({ extensions: workerExts });
    await (await workerConv.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );

    const workerList = captured.get(LIST_MCP_RESOURCES_TOOL_NAME)?.[1]?.structuredOutput as {
      resources: { server: string; uri: string }[];
    };
    assert.deepEqual(workerList.resources.map((r) => r.server).sort(), ["priv", "pub"]);
    const workerPrivRead = captured.get(READ_MCP_RESOURCE_TOOL_NAME)?.[1];
    assert.equal(workerPrivRead?.isError, undefined);
    assert.ok(extractText(workerPrivRead?.output).includes("worker secret"));
  } finally {
    unbind();
    await hub.close();
    await th.cleanup();
  }
});

test("read-only resource calls retry once on transient HTTP 5xx error", async () => {
  let readAttempts = 0;
  let baseUrl = "";
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
      if (msg.method === "resources/read") {
        readAttempts += 1;
        if (readAttempts === 1) {
          res.writeHead(503, { "content-type": "text/plain" });
          res.end("temporarily unavailable");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { contents: [{ uri: "http://doc", text: "recovered after 503" }] },
          }),
        );
        return;
      }
      const result =
        msg.method === "initialize"
          ? {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: { resources: {} },
              serverInfo: { name: "http-res", version: "1.0.0" },
            }
          : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("Expected TCP address");
  baseUrl = `http://127.0.0.1:${addr.port}/mcp`;

  const hub = createMcpHub({
    servers: [{ name: "httpres", config: { type: "http", url: baseUrl } }],
    transientRetryDelayMs: 10,
  });

  try {
    await hub.start();
    const res = await hub.readResource("httpres", "http://doc");
    assert.equal(readAttempts, 2);
    assert.equal(
      "text" in (res.contents[0] ?? {}) ? (res.contents[0] as { text: string }).text : "",
      "recovered after 503",
    );
  } finally {
    await hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
