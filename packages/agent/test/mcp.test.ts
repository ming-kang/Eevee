import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import {
  type Conversation,
  defineExtension,
  type Extension,
  hook,
  type ToolExecutionResult,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import {
  type CallToolResult,
  LATEST_PROTOCOL_VERSION,
  type Tool as McpTool,
  type McpTransport,
  PipeTransport,
} from "@earendil-works/pi-mcp";
import {
  adaptMcpTools,
  convertMcpResult,
  createCodemodeExtension,
  createMcpExtension,
  createMcpHub,
  createMcpResultSchema,
  createToolSearchExtension,
  getMcpToolExposure,
  MCP_EXTENSION,
  type McpHub,
  type McpHubOptions,
  type McpServerEntry,
  type McpStdioServerConfig,
  mcpServerExtensionName,
  parseMcpConfig,
  resolveServerEnv,
  resolveServerHeaders,
  validateMcpServerEntry,
} from "../src/index.ts";
import { createTestHarness, extractText } from "./harness.ts";

type FakeCallHandler = (
  name: string,
  args: Record<string, unknown>,
) => CallToolResult | Promise<CallToolResult>;

type PipeLink = {
  readonly onStdout: (bytes: Uint8Array) => void;
  readonly exited: Promise<void>;
  readonly finish: () => void;
  buffer: string;
  closed: boolean;
};

class FakeMcpServer {
  tools: McpTool[];
  instructions?: string;
  failInitialize = false;
  callHandler: FakeCallHandler = () => ({ content: [{ type: "text", text: "ok" }] });
  connectCount = 0;
  initializeCount = 0;
  listToolsCount = 0;
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  private link?: PipeLink;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(tools: McpTool[] = [], options: { instructions?: string } = {}) {
    this.tools = [...tools];
    this.instructions = options.instructions;
  }

  createTransport(): McpTransport {
    return new PipeTransport({
      closeTimeoutMs: 20,
      open: async (handlers) => {
        this.connectCount += 1;
        const link = this.attach(handlers.onStdout);
        return {
          write: (data) => this.receive(link, data),
          closeStdin: () => this.finish(link),
          close: () => this.finish(link),
          exited: link.exited,
        };
      },
    });
  }

  setTools(tools: McpTool[]): void {
    this.tools = [...tools];
  }

  pushToolsChanged(): void {
    if (this.link !== undefined && !this.link.closed) {
      this.send(this.link, { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
  }

  drop(): void {
    if (this.link !== undefined) this.finish(this.link);
  }

  private attach(onStdout: (bytes: Uint8Array) => void): PipeLink {
    let finish = () => {};
    const exited = new Promise<void>((resolve) => {
      finish = () => resolve();
    });
    const link: PipeLink = { onStdout, exited, finish, buffer: "", closed: false };
    this.link = link;
    return link;
  }

  private finish(link: PipeLink): void {
    if (link.closed) return;
    link.closed = true;
    if (this.link === link) this.link = undefined;
    queueMicrotask(link.finish);
  }

  private send(link: PipeLink, message: Record<string, unknown>): void {
    if (link.closed) return;
    link.onStdout(this.encoder.encode(`${JSON.stringify(message)}\n`));
  }

  private receive(link: PipeLink, data: Uint8Array | string): void {
    if (link.closed) return;
    link.buffer += typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    for (;;) {
      const newline = link.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = link.buffer.slice(0, newline).trim();
      link.buffer = link.buffer.slice(newline + 1);
      if (line === "") continue;
      this.handleMessage(link, JSON.parse(line) as Record<string, unknown>);
    }
  }

  private handleMessage(link: PipeLink, message: Record<string, unknown>): void {
    if (!("id" in message)) return;
    const id = message.id as string | number;
    const method = message.method;
    if (method === "initialize") {
      this.initializeCount += 1;
      if (this.failInitialize) {
        this.send(link, {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "initialize failed" },
        });
        return;
      }
      this.send(link, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
          ...(this.instructions === undefined ? {} : { instructions: this.instructions }),
        },
      });
      return;
    }
    if (method === "tools/list") {
      this.listToolsCount += 1;
      this.send(link, { jsonrpc: "2.0", id, result: { tools: this.tools } });
      return;
    }
    if (method === "tools/call") {
      void this.handleCall(link, id, message.params);
      return;
    }
    this.send(link, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    });
  }

  private async handleCall(link: PipeLink, id: string | number, params: unknown): Promise<void> {
    const request = typeof params === "object" && params !== null ? params : {};
    const name =
      typeof (request as { name?: unknown }).name === "string"
        ? (request as { name: string }).name
        : "";
    const args = (request as { arguments?: unknown }).arguments;
    const argsRecord =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    this.calls.push({ name, args: argsRecord });
    try {
      const result = await this.callHandler(name, argsRecord);
      this.send(link, { jsonrpc: "2.0", id, result });
    } catch (error) {
      this.send(link, {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

function tool(
  name: string,
  description: string,
  options: {
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    readOnly?: boolean;
    title?: string;
  } = {},
): McpTool {
  return {
    name,
    description,
    inputSchema: options.inputSchema ?? { type: "object", properties: {} },
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.readOnly === undefined ? {} : { annotations: { readOnlyHint: options.readOnly } }),
  };
}

function stdioEntry(name: string, config: Partial<McpStdioServerConfig> = {}): McpServerEntry {
  return {
    name,
    config: { command: "fake-mcp-server", ...config } as McpStdioServerConfig,
  };
}

function createPipeHub(
  servers: Readonly<Record<string, FakeMcpServer>>,
  entries: readonly McpServerEntry[],
  options: Omit<McpHubOptions, "servers" | "createTransport"> = {},
): McpHub {
  return createMcpHub({
    ...options,
    servers: entries,
    createTransport: (entry) => {
      const server = servers[entry.name];
      if (server === undefined) throw new Error(`No fake server for ${entry.name}`);
      return server.createTransport();
    },
  });
}

type ToolResultEntry = {
  toolName?: string;
  isError?: boolean;
  content?: unknown;
  details?: unknown;
};

async function toolResults(conversation: Conversation): Promise<ToolResultEntry[]> {
  const entries = await conversation.entries({}, 300, undefined, BACKGROUND_CONTEXT);
  const results: ToolResultEntry[] = [];
  for (const entry of entries.items) {
    if (entry.kind !== "pi.tool-result") continue;
    const model = (entry as { model?: unknown[] }).model;
    const first = Array.isArray(model) ? (model[0] as ToolResultEntry) : undefined;
    if (first !== undefined) results.push(first);
  }
  return results;
}

function resultText(result: ToolResultEntry): string {
  return extractText(result.content);
}

function outputText(result: ToolExecutionResult): string {
  return extractText(result.output);
}

function required<T>(value: T | undefined, label = "value"): T {
  if (value === undefined) throw new Error(`expected ${label}`);
  return value;
}

function bracedEnvRef(name: string): string {
  return ["$", "{", name, "}"].join("");
}

async function executeRegistration(
  registration: ToolRegistration,
  args: Record<string, unknown> = {},
  context: Context = BACKGROUND_CONTEXT,
): Promise<ToolExecutionResult> {
  return (await registration.execute(args, {} as never, context)) as ToolExecutionResult;
}

function captureToolExecutionExtension(captured: Map<string, ToolExecutionResult[]>): Extension {
  return defineExtension({
    name: "eevee.test.capture",
    hooks: [
      hook(ToolTask, {
        afterTool: (call, result) => {
          const copy = structuredClone(result) as ToolExecutionResult;
          const list = captured.get(call.name) ?? [];
          list.push(copy);
          captured.set(call.name, list);
        },
      }),
    ],
  });
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function parseCodemodePayload(text: string): Record<string, unknown> {
  const marker = "Output:\n";
  const index = text.indexOf(marker);
  assert.notEqual(index, -1, text);
  return JSON.parse(text.slice(index + marker.length).trim()) as Record<string, unknown>;
}

test("parseMcpConfig accepts stdio and HTTP configs, JSONC, BOM, and applies deferred defaults", () => {
  const parsed = parseMcpConfig({
    mcpServers: {
      local: {
        command: "server-command",
        args: ["--serve"],
        env: { TOKEN: "$EEVEE_MCP_TEST_TOKEN" },
        description: "Local tools",
      },
      remote: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: `Bearer ${bracedEnvRef("EEVEE_MCP_TEST_TOKEN")}` },
        timeout: 5,
      },
    },
  });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.servers.length, 2);
  assert.equal(parsed.servers[0]?.name, "local");
  assert.equal(parsed.servers[1]?.name, "remote");
  assert.equal(getMcpToolExposure(required(parsed.servers[0]).config, "anything"), "deferred");

  const jsonc = parseMcpConfig(
    '\uFEFF{\n  // a comment\n  "mcpServers": {\n    /* block */\n    "docs": { "command": "docs-server" }\n  }\n}',
  );
  assert.deepEqual(jsonc.errors, []);
  assert.deepEqual(
    jsonc.servers.map((server) => server.name),
    ["docs"],
  );
});

test("validateMcpServerEntry normalizes codemode-deferred and rejects invalid entries", () => {
  const valid = validateMcpServerEntry("scripts", {
    command: "run",
    exposure: "codemode-deferred",
    toolExposure: { a: "codemode-deferred", b: "direct" },
  });
  assert.notEqual(typeof valid, "string");
  if (typeof valid !== "string") {
    assert.equal(valid.exposure, "codemode");
    assert.deepEqual(valid.toolExposure, { a: "codemode", b: "direct" });
  }

  assert.match(String(validateMcpServerEntry("bad name", { command: "x" })), /invalid server name/);
  assert.match(
    String(validateMcpServerEntry("missing", {})),
    /needs either "command" \(stdio\) or "url"/,
  );
  assert.match(
    String(validateMcpServerEntry("bad-exposure", { command: "x", exposure: "sometimes" })),
    /exposure must be one of/,
  );
  assert.match(
    String(
      validateMcpServerEntry("bad-tool-exposure", {
        command: "x",
        toolExposure: { a: "sometimes" },
      }),
    ),
    /toolExposure "a" must be one of/,
  );
});

test("parseMcpConfig reports invalid JSON, invalid shapes, and namespace collisions", () => {
  assert.match(parseMcpConfig("{").errors[0] ?? "", /invalid MCP config JSON/);
  assert.deepEqual(parseMcpConfig({ mcpServers: [] as never }).servers, []);
  const mixed = parseMcpConfig({
    mcpServers: {
      good: { command: "good-server" },
      bad: {},
    },
  });
  assert.deepEqual(
    mixed.servers.map((server) => server.name),
    ["good"],
  );
  assert.equal(mixed.errors.length, 1);
  assert.match(
    parseMcpConfig({ mcpServers: [] as never }).errors[0] ?? "",
    /expected an object with an "mcpServers" object/,
  );

  const collision = parseMcpConfig({
    mcpServers: {
      "foo-bar": { command: "one" },
      foo_bar: { command: "two" },
    },
  });
  assert.deepEqual(
    collision.servers.map((server) => server.name),
    ["foo-bar"],
  );
  assert.match(collision.errors[0] ?? "", /conflicts with "foo-bar"/);
  assert.match(collision.errors[0] ?? "", /mcp__foo_bar/);
});

test("getMcpToolExposure applies exact matches before wildcard matches in object order", () => {
  const config = {
    command: "x",
    exposure: "hidden",
    toolExposure: {
      "get_*": "codemode",
      get_me: "direct",
      "*delete*": "hidden",
      "get_file.*": "direct",
    },
  } as McpStdioServerConfig;
  assert.equal(getMcpToolExposure(config, "get_me"), "direct");
  assert.equal(getMcpToolExposure(config, "get_issue"), "codemode");
  assert.equal(getMcpToolExposure(config, "get_file.txt"), "codemode");
  assert.equal(getMcpToolExposure(config, "please_delete_now"), "hidden");
  assert.equal(getMcpToolExposure(config, "other"), "hidden");
});

test("resolveServerEnv and resolveServerHeaders interpolate dollar variables or fail clearly", () => {
  const baseEnv = {
    EEVEE_MCP_TEST_TOKEN: "secret-token",
    EEVEE_MCP_TEST_REGION: "test-region",
    EEVEE_MCP_EMPTY: "",
  };
  assert.deepEqual(
    resolveServerEnv(
      {
        TOKEN: "$EEVEE_MCP_TEST_TOKEN",
        REGION: `region-${bracedEnvRef("EEVEE_MCP_TEST_REGION")}`,
        LITERAL: "$$EEVEE_MCP_TEST_TOKEN",
      },
      baseEnv,
    ),
    {
      TOKEN: "secret-token",
      REGION: "region-test-region",
      LITERAL: "$EEVEE_MCP_TEST_TOKEN",
    },
  );
  assert.deepEqual(
    resolveServerHeaders(
      { Authorization: `Bearer ${bracedEnvRef("EEVEE_MCP_TEST_TOKEN")}` },
      baseEnv,
    ),
    { Authorization: "Bearer secret-token" },
  );
  assert.throws(
    () => resolveServerEnv({ MISSING: "$EEVEE_MCP_MISSING_TEST_VARIABLE" }, baseEnv),
    /env "MISSING".*EEVEE_MCP_MISSING_TEST_VARIABLE/,
  );
  assert.throws(
    () =>
      resolveServerEnv(
        { MISSING: `$EEVEE_MCP_MISSING_ONE x ${bracedEnvRef("EEVEE_MCP_MISSING_TWO")}` },
        baseEnv,
      ),
    /EEVEE_MCP_MISSING_ONE.*EEVEE_MCP_MISSING_TWO/,
  );
  assert.throws(
    () => resolveServerHeaders({ Authorization: bracedEnvRef("EEVEE_MCP_EMPTY") }, baseEnv),
    /header "Authorization".*EEVEE_MCP_EMPTY/,
  );
});

test("createMcpResultSchema relocates local refs beneath structuredContent", () => {
  const schema = createMcpResultSchema({
    type: "object",
    properties: {
      item: { $ref: "#/$defs/Item" },
      root: { $ref: "#" },
    },
    $defs: {
      Item: {
        type: "object",
        properties: { again: { $ref: "#/$defs/Item" } },
      },
    },
    examples: [{ $ref: "#/not-a-reference" }],
  }) as {
    properties: {
      structuredContent: {
        properties: { item: { $ref: string }; root: { $ref: string } };
        $defs: { Item: { properties: { again: { $ref: string } } } };
        examples: { $ref: string }[];
      };
    };
  };
  const structured = schema.properties.structuredContent;
  assert.equal(structured.properties.item.$ref, "#/properties/structuredContent/$defs/Item");
  assert.equal(structured.properties.root.$ref, "#/properties/structuredContent");
  assert.equal(
    structured.$defs.Item.properties.again.$ref,
    "#/properties/structuredContent/$defs/Item",
  );
  assert.deepEqual(structured.examples, [{ $ref: "#/not-a-reference" }]);
});

test("convertMcpResult converts resource links and binary resources and drops top-level _meta", async () => {
  const saved: { data: string | Uint8Array; extension: string; path: string }[] = [];
  const result = await convertMcpResult(
    "docs",
    "mixed",
    {
      content: [
        {
          type: "resource_link",
          uri: "file:///spec.pdf",
          name: "spec",
          title: "Specification",
          mimeType: "application/pdf",
          size: 2048,
          description: "read the spec",
        },
        {
          type: "resource",
          resource: {
            uri: "file:///data.bin",
            mimeType: "application/octet-stream",
            blob: Buffer.from("binary-data").toString("base64"),
          },
        },
      ],
      structuredContent: { ok: true },
      _meta: { secret: true },
    },
    {
      saveOutput: async (data, extension) => {
        const path = `/tmp/saved-${saved.length}${extension}`;
        saved.push({ data, extension, path });
        return path;
      },
    },
  );
  const text = outputText(result);
  assert.ok(
    text.includes(
      '[Resource file:///spec.pdf "Specification" (application/pdf, 2.0KB): read the spec]',
    ),
  );
  assert.ok(
    text.includes(
      "[Binary resource file:///data.bin (application/octet-stream, 11B) saved to /tmp/saved-0.bin]",
    ),
  );
  assert.equal(saved.length, 1);
  assert.equal(Buffer.from(required(saved[0]).data as Uint8Array).toString("utf8"), "binary-data");
  const structured = result.structuredOutput as {
    content: unknown[];
    structuredContent: unknown;
    _meta?: unknown;
  };
  assert.deepEqual(structured.structuredContent, { ok: true });
  assert.equal(structured._meta, undefined);
  assert.equal(structured.content.length, 2);

  const binaryBlock = {
    type: "resource" as const,
    resource: {
      uri: "file:///data.bin",
      mimeType: "application/octet-stream",
      blob: Buffer.from("binary-data").toString("base64"),
    },
  };
  const withoutSaver = await convertMcpResult("docs", "mixed", { content: [binaryBlock] });
  assert.ok(
    outputText(withoutSaver).includes(
      "[Binary resource file:///data.bin (application/octet-stream, 11B) omitted]",
    ),
  );
  const jsonResource = await convertMcpResult("docs", "mixed", {
    content: [
      {
        type: "resource",
        resource: {
          uri: "file:///data.json",
          mimeType: "application/json",
          blob: Buffer.from('{"ok":true}').toString("base64"),
        },
      },
    ],
  });
  assert.equal(outputText(jsonResource), '{"ok":true}');
});

test("adaptMcpTools applies exposure, naming, replay hints, and converts transport failures", async () => {
  const calls: {
    name: string;
    args: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }[] = [];
  const registrations = adaptMcpTools({
    server: "odd-server",
    config: {
      command: "x",
      exposure: "hidden",
      toolExposure: { visible: "direct", "a-b": "direct", a_b: "direct", readonly: "direct" },
    },
    tools: [
      tool("visible", "Visible"),
      tool("hidden", "Hidden"),
      tool("a-b", "Dash"),
      tool("a_b", "Underscore"),
      tool("readonly", "Readonly", { readOnly: true }),
    ],
    timeoutMs: 1234,
    callTool: async (name, args, options) => {
      calls.push({ name, args, timeoutMs: options.timeoutMs, signal: options.signal });
      throw new Error("transport exploded");
    },
  });
  const names = registrations.map((registration) => registration.name);
  assert.equal(names.length, 4);
  assert.ok(names.includes("mcp__odd_server__visible"));
  assert.ok(!names.includes("mcp__odd_server__hidden"));
  assert.notEqual(names[1], names[2]);
  assert.equal(
    registrations.find((registration) => registration.name === "mcp__odd_server__visible")
      ?.deferred,
    undefined,
  );
  assert.equal(
    registrations.find((registration) => registration.name === "mcp__odd_server__readonly")?.replay,
    "safe",
  );

  const controller = new AbortController();
  const failed = await executeRegistration(
    required(registrations[0]),
    { query: "pineapple" },
    withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
  );
  assert.equal(failed.isError, true);
  assert.ok(outputText(failed).includes("transport exploded"));
  assert.deepEqual(failed.details, { server: "odd-server", tool: "visible" });
  assert.equal(calls.length, 1);
  assert.equal(required(calls[0]).name, "visible");
  assert.deepEqual(required(calls[0]).args, { query: "pineapple" });
  assert.equal(required(calls[0]).timeoutMs, 1234);
  assert.equal(required(calls[0]).signal, controller.signal);
});

test("adaptMcpTools marks deferred and codemode exposures for discovery paths", () => {
  const registrations = adaptMcpTools({
    server: "modes",
    config: {
      command: "x",
      exposure: "deferred",
      toolExposure: { script: "codemode", visible: "direct", gone: "hidden" },
    },
    tools: [
      tool("deferred", "Deferred"),
      tool("script", "Script"),
      tool("visible", "Visible"),
      tool("gone", "Gone"),
    ],
    timeoutMs: 1000,
    callTool: async () => ({ content: [] }),
  });
  const byName = new Map(registrations.map((registration) => [registration.name, registration]));
  assert.equal(byName.get("mcp__modes__deferred")?.deferred, true);
  assert.equal(byName.get("mcp__modes__deferred")?.callers, undefined);
  assert.equal(byName.get("mcp__modes__script")?.deferred, true);
  assert.deepEqual(byName.get("mcp__modes__script")?.callers, ["tools"]);
  assert.equal(byName.get("mcp__modes__visible")?.deferred, undefined);
  assert.equal(byName.has("mcp__modes__gone"), false);
});

test("McpHub renders no section without enabled servers and createMcpExtension exposes its hub", async () => {
  const hub = createMcpHub({ servers: [stdioEntry("off", { enabled: false })] });
  const extension = hub.extension();
  assert.equal(extension.name, MCP_EXTENSION);
  const section = extension.sections?.find((candidate) => candidate.key === "mcp_servers");
  assert.equal(await section?.render({} as never, BACKGROUND_CONTEXT), undefined);

  const wrapped = createMcpExtension(hub);
  assert.equal(wrapped.name, MCP_EXTENSION);
  assert.equal(wrapped.hub, hub);
  await hub.close();
});

test("deferred MCP tools are discovered with tool_search, called by the model, and keep structuredOutput", async () => {
  const lookup = tool("lookup", "Lookup unique pineapple facts", {
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Fact query" } },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
    readOnly: true,
  });
  const server = new FakeMcpServer([lookup], { instructions: "Pineapple reference tools" });
  server.callHandler = (_name, args) => ({
    content: [{ type: "text", text: `fact for ${String(args.query)}` }],
    structuredContent: { answer: `fact for ${String(args.query)}`, confidence: 0.9 },
    _meta: { serverOnly: true },
  });
  const entry = stdioEntry("docs", { description: "Pineapple documentation" });
  const hub = createPipeHub({ docs: server }, [entry]);
  const captured = new Map<string, ToolExecutionResult[]>();
  const th = await createTestHarness({
    extensions: [createToolSearchExtension(), captureToolExecutionExtension(captured)],
  });
  const unbind = hub.bindRegistry(th.registry);
  try {
    await hub.start();
    assert.equal(hub.status()[0]?.status, "connected");
    const observations: { prompt: string; tools: string[] }[] = [];
    th.faux.setResponses([
      (context) => {
        observations.push({
          prompt: getCurrentSystemPrompt(context.messages),
          tools: getCurrentTools(context.messages).map((candidate) => candidate.name),
        });
        return fauxAssistantMessage([fauxToolCall("tool_search", { query: "pineapple" })], {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage([fauxToolCall("mcp__docs__lookup", { query: "pineapple" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation({ extensions: null });
    const before = await conversation.agent(BACKGROUND_CONTEXT);
    assert.ok(!before.tools.some((candidate) => candidate.name === "mcp__docs__lookup"));
    assert.ok(before.deferred.some((candidate) => candidate.name === "mcp__docs__lookup"));

    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);

    assert.equal(observations.length, 1);
    const firstRequest = required(observations[0]);
    assert.ok(!firstRequest.tools.includes("mcp__docs__lookup"));
    assert.ok(firstRequest.tools.includes("tool_search"));
    assert.ok(firstRequest.prompt.includes("mcp__docs"));
    assert.ok(firstRequest.prompt.includes("Pineapple documentation"));
    assert.ok(firstRequest.prompt.includes("tool_search"));

    const results = await toolResults(conversation);
    const search = results.find((result) => result.toolName === "tool_search");
    const mcp = results.find((result) => result.toolName === "mcp__docs__lookup");
    assert.ok(resultText(search ?? {}).includes("Loaded 1 tool"));
    assert.equal(mcp?.isError, false);
    assert.ok(resultText(mcp ?? {}).includes("fact for pineapple"));
    assert.deepEqual(server.calls, [{ name: "lookup", args: { query: "pineapple" } }]);

    const structured = captured.get("mcp__docs__lookup")?.[0]?.structuredOutput as {
      content: { type: string; text?: string }[];
      structuredContent: unknown;
      _meta?: unknown;
    };
    assert.equal(structured.content[0]?.text, "fact for pineapple");
    assert.deepEqual(structured.structuredContent, {
      answer: "fact for pineapple",
      confidence: 0.9,
    });
    assert.equal(structured._meta, undefined);

    const after = await conversation.agent(BACKGROUND_CONTEXT);
    assert.ok(after.tools.some((candidate) => candidate.name === "mcp__docs__lookup"));
  } finally {
    unbind();
    await hub.close();
    await th.cleanup();
  }
});

test("codemode MCP tools are hidden from tool_search but visible to scripts through their namespace", async () => {
  const add = tool("add", "Add numbers precisely", {
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    outputSchema: {
      type: "object",
      properties: { sum: { type: "number" } },
      required: ["sum"],
    },
  });
  const server = new FakeMcpServer([add], { instructions: "Arithmetic instructions" });
  server.callHandler = (_name, args) => ({
    content: [{ type: "text", text: `sum ${Number(args.a) + Number(args.b)}` }],
    structuredContent: { sum: Number(args.a) + Number(args.b) },
    _meta: { hiddenFromScripts: true },
  });
  const entry = stdioEntry("scripts", {
    description: "Arithmetic namespace",
    exposure: "codemode",
  });
  const hub = createPipeHub({ scripts: server }, [entry]);
  const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
  const th = await createTestHarness({
    extensions: [createToolSearchExtension(), createCodemodeExtension({ sandbox, models: false })],
  });
  const unbind = hub.bindRegistry(th.registry);
  try {
    await hub.start();
    const observations: { prompt: string; tools: string[] }[] = [];
    const code = [
      'const namespace = await describeNamespace("mcp__scripts");',
      'const found = await searchTools("Add numbers", { namespace: "mcp__scripts", limit: 1 });',
      "const result = await tools.mcp__scripts__add({ a: 2, b: 3 });",
      "return { namespace, found, result };",
    ].join("\n");
    th.faux.setResponses([
      (context) => {
        observations.push({
          prompt: getCurrentSystemPrompt(context.messages),
          tools: getCurrentTools(context.messages).map((candidate) => candidate.name),
        });
        return fauxAssistantMessage([fauxToolCall("tool_search", { query: "Add numbers" })], {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation({ extensions: null });
    const before = await conversation.agent(BACKGROUND_CONTEXT);
    assert.ok(!before.deferred.some((candidate) => candidate.name === "mcp__scripts__add"));
    assert.ok(before.callable.some((candidate) => candidate.name === "mcp__scripts__add"));

    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);

    const firstRequest = required(observations[0]);
    assert.ok(firstRequest.prompt.includes("## mcp__scripts"));
    assert.ok(firstRequest.prompt.includes("Arithmetic namespace"));
    assert.ok(!firstRequest.prompt.includes("### `mcp__scripts__add`"));
    assert.ok(!firstRequest.tools.includes("mcp__scripts__add"));

    const results = await toolResults(conversation);
    const search = results.find((result) => result.toolName === "tool_search");
    const codemode = results.find((result) => result.toolName === "codemode");
    assert.ok(resultText(search ?? {}).includes("No matching tools found"));
    assert.equal(codemode?.isError, false);
    const payload = parseCodemodePayload(resultText(codemode ?? {})) as {
      namespace: { name: string; description?: string; instructions?: string; tools: string[] };
      found: { name: string }[];
      result: {
        content: { type: string; text?: string }[];
        structuredContent: { sum: number };
        _meta?: unknown;
      };
    };
    assert.equal(payload.namespace.name, "mcp__scripts");
    assert.equal(payload.namespace.description, "Arithmetic namespace");
    assert.equal(payload.namespace.instructions, "Arithmetic instructions");
    assert.deepEqual(payload.namespace.tools, ["mcp__scripts__add"]);
    assert.equal(payload.found[0]?.name, "mcp__scripts__add");
    assert.equal(payload.result.content[0]?.text, "sum 5");
    assert.deepEqual(payload.result.structuredContent, { sum: 5 });
    assert.equal(payload.result._meta, undefined);
  } finally {
    unbind();
    await hub.close();
    await th.cleanup();
    await sandbox.close();
  }
});

test("direct, deferred, codemode, and hidden exposures resolve distinctly in a live agent", async () => {
  const server = new FakeMcpServer([
    tool("direct_tool", "Direct"),
    tool("deferred_tool", "Deferred"),
    tool("codemode_tool", "Codemode"),
    tool("hidden_tool", "Hidden"),
  ]);
  const entry = stdioEntry("modes", {
    exposure: "direct",
    toolExposure: {
      deferred_tool: "deferred",
      codemode_tool: "codemode",
      hidden_tool: "hidden",
    },
  });
  const hub = createPipeHub({ modes: server }, [entry]);
  const th = await createTestHarness();
  const unbind = hub.bindRegistry(th.registry);
  try {
    await hub.start();
    const conversation = await th.createConversation({ extensions: null });
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    const names = {
      tools: agent.tools.map((candidate) => candidate.name),
      deferred: agent.deferred.map((candidate) => candidate.name),
      callable: agent.callable.map((candidate) => candidate.name),
    };
    assert.ok(names.tools.includes("mcp__modes__direct_tool"));
    assert.ok(!names.tools.includes("mcp__modes__deferred_tool"));
    assert.ok(!names.tools.includes("mcp__modes__codemode_tool"));
    assert.ok(!names.tools.includes("mcp__modes__hidden_tool"));
    assert.ok(names.deferred.includes("mcp__modes__deferred_tool"));
    assert.ok(!names.deferred.includes("mcp__modes__codemode_tool"));
    assert.ok(names.callable.includes("mcp__modes__direct_tool"));
    assert.ok(names.callable.includes("mcp__modes__deferred_tool"));
    assert.ok(names.callable.includes("mcp__modes__codemode_tool"));
    assert.ok(!names.callable.includes("mcp__modes__hidden_tool"));
  } finally {
    unbind();
    await hub.close();
    await th.cleanup();
  }
});

test("MCP isError results reach the model as errors and still resolve for codemode scripts", async () => {
  const failing = tool("fail", "Return a structured failure", {
    outputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  });
  const server = new FakeMcpServer([failing]);
  server.callHandler = () => ({
    content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    structuredContent: { code: "bad" },
    isError: true,
  });
  const entry = stdioEntry("bad", { exposure: "direct" });
  const hub = createPipeHub({ bad: server }, [entry]);
  const captured = new Map<string, ToolExecutionResult[]>();
  const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
  const th = await createTestHarness({
    extensions: [
      captureToolExecutionExtension(captured),
      createCodemodeExtension({ sandbox, models: false }),
    ],
  });
  const unbind = hub.bindRegistry(th.registry);
  try {
    await hub.start();
    const code = [
      "const result = await tools.mcp__bad__fail({});",
      "return { resolved: true, result };",
    ].join("\n");
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("mcp__bad__fail", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation({ extensions: null });
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);

    const results = await toolResults(conversation);
    const mcp = results.find((result) => result.toolName === "mcp__bad__fail");
    assert.equal(mcp?.isError, true);
    assert.ok(resultText(mcp ?? {}).includes("MCP tool bad/fail returned an error"));
    const capturedResult = required(captured.get("mcp__bad__fail")?.[0]);
    assert.equal(capturedResult.isError, true);
    assert.deepEqual(
      (capturedResult.structuredOutput as { structuredContent: unknown }).structuredContent,
      { code: "bad" },
    );

    const codemode = results.find((result) => result.toolName === "codemode");
    assert.equal(codemode?.isError, false);
    const payload = parseCodemodePayload(resultText(codemode ?? {})) as {
      resolved: boolean;
      result: { isError: boolean; structuredContent: unknown };
    };
    assert.equal(payload.resolved, true);
    assert.equal(payload.result.isError, true);
    assert.deepEqual(payload.result.structuredContent, { code: "bad" });
  } finally {
    unbind();
    await hub.close();
    await th.cleanup();
    await sandbox.close();
  }
});

test("large MCP output is middle-truncated for the model and saved in full", async () => {
  const large = tool("large", "Produce large output", {
    outputSchema: { type: "object", properties: { text: { type: "string" } } },
  });
  const server = new FakeMcpServer([large]);
  const fullText = `${"a".repeat(12_000)}MIDDLE-MARKER${"z".repeat(13_000)}`;
  server.callHandler = () => ({
    content: [{ type: "text", text: fullText }],
    structuredContent: { text: fullText },
  });
  const entry = stdioEntry("large-server", { exposure: "direct" });
  const captured = new Map<string, ToolExecutionResult[]>();
  const th = await createTestHarness({ extensions: [captureToolExecutionExtension(captured)] });
  const fullOutputPath = join(th.dir, "mcp-full-output.txt");
  let savedCalls = 0;
  const hub = createPipeHub({ "large-server": server }, [entry], {
    saveOutput: async (data, extension) => {
      savedCalls += 1;
      assert.equal(extension, ".txt");
      await writeFile(fullOutputPath, data);
      return fullOutputPath;
    },
  });
  const unbind = hub.bindRegistry(th.registry);
  try {
    await hub.start();
    th.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("mcp__large_server__large", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const conversation = await th.createConversation({ extensions: null });
    const submission = await conversation.submit(
      { type: "input", content: "go" },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);

    const results = await toolResults(conversation);
    const mcp = results.find((result) => result.toolName === "mcp__large_server__large");
    assert.equal(mcp?.isError, false);
    const text = resultText(mcp ?? {});
    assert.ok(text.includes("Warning: truncated output"));
    assert.ok(text.includes("chars truncated"));
    assert.ok(!text.includes("MIDDLE-MARKER"));
    assert.ok(text.includes(`[Full output: ${fullOutputPath}`));
    assert.equal(
      (mcp?.details as { fullOutputPath?: string } | undefined)?.fullOutputPath,
      fullOutputPath,
    );
    assert.equal(savedCalls, 1);
    assert.equal(await readFile(fullOutputPath, "utf8"), fullText);

    const structured = captured.get("mcp__large_server__large")?.[0]?.structuredOutput as {
      content: { text?: string }[];
      structuredContent: { text: string };
    };
    assert.equal(structured.content[0]?.text, fullText);
    assert.equal(structured.structuredContent.text, fullText);
  } finally {
    unbind();
    await hub.close();
    await th.cleanup();
  }
});

test("one failing server does not prevent a healthy server from connecting and serving tools", async () => {
  const broken = new FakeMcpServer([tool("broken_tool", "Broken")]);
  broken.failInitialize = true;
  const healthy = new FakeMcpServer([tool("healthy_tool", "Healthy")]);
  healthy.callHandler = () => ({ content: [{ type: "text", text: "healthy answer" }] });
  const entries = [stdioEntry("broken"), stdioEntry("healthy")];
  const hub = createPipeHub({ broken, healthy }, entries);
  try {
    await hub.start();
    const statuses = new Map(hub.status().map((status) => [status.name, status]));
    assert.equal(statuses.get("broken")?.status, "failed");
    assert.match(statuses.get("broken")?.error ?? "", /initialize failed/);
    assert.equal(statuses.get("healthy")?.status, "connected");
    assert.equal(statuses.get("healthy")?.toolCount, 1);

    const extension = hub
      .serverExtensions()
      .find((candidate) => candidate.name === mcpServerExtensionName("healthy"));
    const registration = extension?.tools?.find(
      (candidate) => candidate.name === "mcp__healthy__healthy_tool",
    );
    assert.ok(registration);
    const result = await executeRegistration(registration);
    assert.equal(result.isError, undefined);
    assert.equal(outputText(result), "healthy answer");
  } finally {
    await hub.close();
  }
});

test("a dropped connection becomes disconnected and the next tool call lazily reconnects once", async () => {
  const server = new FakeMcpServer([tool("echo", "Echo")]);
  server.callHandler = (_name, args) => ({
    content: [{ type: "text", text: `echo ${String(args.value ?? "")}` }],
  });
  const hub = createPipeHub({ echoer: server }, [stdioEntry("echoer")]);
  try {
    await hub.start();
    assert.equal(server.connectCount, 1);
    server.drop();
    await waitFor(() => hub.status()[0]?.status === "disconnected", "server to disconnect");

    const extension = hub
      .serverExtensions()
      .find((candidate) => candidate.name === mcpServerExtensionName("echoer"));
    const registration = extension?.tools?.find(
      (candidate) => candidate.name === "mcp__echoer__echo",
    );
    assert.ok(registration);
    const result = await executeRegistration(registration, { value: "again" });
    assert.equal(result.isError, undefined);
    assert.equal(outputText(result), "echo again");
    assert.equal(server.connectCount, 2);
    assert.equal(hub.status()[0]?.status, "connected");
  } finally {
    await hub.close();
  }
});

test("tool list notifications and reload update bound registries live, and close tears down cleanly", async () => {
  const firstTool = tool("first", "First tool");
  const secondTool = tool("second", "Second tool");
  const alpha = new FakeMcpServer([firstTool]);
  const beta = new FakeMcpServer([tool("beta_tool", "Beta tool")]);
  const alphaEntry = stdioEntry("alpha");
  const betaEntry = stdioEntry("beta");
  const hub = createPipeHub({ alpha, beta }, [alphaEntry]);
  const th = await createTestHarness();
  const unbind = hub.bindRegistry(th.registry);
  try {
    await hub.start();
    const alphaExtension = mcpServerExtensionName("alpha");
    const betaExtension = mcpServerExtensionName("beta");
    const alphaTools = () =>
      th.registry
        .snapshot()
        .extension(alphaExtension)
        ?.tools?.map((candidate) => candidate.name) ?? [];
    assert.deepEqual(alphaTools(), ["mcp__alpha__first"]);

    alpha.setTools([firstTool, secondTool]);
    alpha.pushToolsChanged();
    await waitFor(() => alphaTools().includes("mcp__alpha__second"), "live tool refresh");
    assert.deepEqual(alphaTools(), ["mcp__alpha__first", "mcp__alpha__second"]);

    const alphaConnections = alpha.connectCount;
    await hub.reload([alphaEntry, betaEntry]);
    assert.equal(alpha.connectCount, alphaConnections);
    assert.equal(beta.connectCount, 1);
    assert.ok(
      th.registry
        .snapshot()
        .extension(betaExtension)
        ?.tools?.some((candidate) => candidate.name === "mcp__beta__beta_tool"),
    );

    const changedAlpha = stdioEntry("alpha", { description: "Changed alpha" });
    await hub.reload([changedAlpha, betaEntry]);
    assert.equal(alpha.connectCount, alphaConnections + 1);
    assert.equal(hub.status().find((status) => status.name === "alpha")?.status, "connected");

    await hub.reload([betaEntry]);
    assert.deepEqual(
      hub.status().map((status) => status.name),
      ["beta"],
    );
    assert.equal(th.registry.snapshot().extension(alphaExtension), undefined);
    assert.notEqual(th.registry.snapshot().extension(betaExtension), undefined);

    await Promise.all([hub.close(), hub.close()]);
    assert.deepEqual(
      hub.status().map((status) => status.status),
      ["closed"],
    );
    unbind();
    assert.equal(th.registry.snapshot().extension(betaExtension), undefined);
    assert.equal(th.registry.snapshot().extension(MCP_EXTENSION), undefined);
  } finally {
    await hub.close();
    await th.cleanup();
  }
});
