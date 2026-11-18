import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { McpHub } from "./hub.ts";
import {
  type FakeMcpServer,
  fakeMcpServer as fakeServer,
  weatherTool as weather,
} from "./testing.ts";

async function withHub(
  config: unknown,
  servers: Record<string, FakeMcpServer>,
  run: (hub: McpHub, changes: { count: number }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-mcp-"));
  const changes = { count: 0 };
  await writeFile(join(dir, "mcp.json"), JSON.stringify(config));
  const hub = new McpHub({
    configPath: join(dir, "mcp.json"),
    outputDir: join(dir, "out"),
    client: { name: "eevee-test", version: "0.0.0" },
    onChange: () => {
      changes.count += 1;
    },
    open: (entry) => {
      const server = servers[entry.name];
      if (server === undefined) throw new Error(`No server ${entry.name}`);
      return server.client;
    },
  });
  try {
    await hub.start();
    await run(hub, changes);
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function connected(hub: McpHub, name: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const state = hub.status().find((s) => s.name === name)?.state;
    if (state === "connected" || state === "failed") return;
    await sleep(10);
  }
  throw new Error(`${name} did not connect`);
}

const execute = (tool: ToolRegistration | undefined, args: unknown) =>
  tool?.execute(args as never, {} as ToolExecutionApi, { abortSignal: undefined } as never);

test("an MCP server becomes an mcp.<name> extension, tools load lazily by default and calls go to the server", async () => {
  const servers = { weather: fakeServer([weather], "Weather service\nsecond line") };
  const config = { mcpServers: { weather: { command: "unused" } } };
  await withHub(config, servers, async (hub, changes) => {
    assert.deepEqual(
      hub.extensions().map((e) => [e.name, e.tools?.length ?? 0]),
      [["mcp.weather", 0]],
    );
    await connected(hub, "weather");
    assert.ok(changes.count >= 2);
    const [extension] = hub.extensions();
    const tool = extension?.tools?.[0];
    assert.equal(tool?.name, "mcp__weather__get_weather");
    assert.equal(tool?.deferred, true);
    const result = await execute(tool, { city: "Hangzhou" });
    assert.deepEqual(result?.output, [{ type: "text", text: 'get-weather {"city":"Hangzhou"}' }]);
    assert.deepEqual(hub.namespaces(), [
      { name: "mcp__weather", prefix: "mcp__weather__", description: "Weather service" },
    ]);
    assert.deepEqual(
      hub.status().map((s) => [s.state, s.tools, s.exposure]),
      [["connected", 1, "deferred"]],
    );
  });
});

test("exposure decides how tools reach the model; a disabled server does not connect", async () => {
  const servers = {
    direct: fakeServer([weather]),
    scripted: fakeServer([weather]),
    hidden: fakeServer([weather]),
  };
  const config = {
    mcpServers: {
      direct: { command: "x", exposure: "direct" },
      scripted: { command: "x", exposure: "codemode" },
      hidden: { command: "x", exposure: "hidden" },
      off: { command: "x", enabled: false },
      bad: { command: "x", exposure: "everywhere" },
    },
  };
  await withHub(config, servers, async (hub) => {
    await Promise.all(["direct", "scripted", "hidden"].map((name) => connected(hub, name)));
    const tools = Object.fromEntries(hub.extensions().map((e) => [e.name, e.tools ?? []]));
    assert.equal(tools["mcp.direct"]?.[0]?.deferred, undefined);
    assert.deepEqual(tools["mcp.scripted"]?.[0]?.callers, ["tools"]);
    assert.deepEqual(tools["mcp.hidden"], []);
    assert.equal(tools["mcp.off"], undefined);
    assert.equal(hub.status().find((s) => s.name === "off")?.state, "disabled");
    assert.deepEqual(hub.problems(), [
      {
        file: "mcp.json",
        entry: "bad",
        code: "invalid",
        field: "exposure",
        allowed: ["deferred", "direct", "codemode", "hidden"],
      },
    ]);
  });
});

test("after a connection drops the extension loses its tools; reload reconnects", async () => {
  let server = fakeServer([weather]);
  const servers = {
    get weather() {
      return server;
    },
  };
  await withHub({ mcpServers: { weather: { command: "x" } } }, servers, async (hub) => {
    await connected(hub, "weather");
    await server.server.close();
    for (let i = 0; i < 100 && hub.status()[0]?.state === "connected"; i++) await sleep(10);
    assert.equal(hub.status()[0]?.state, "failed");
    assert.equal(hub.extensions()[0]?.tools?.length ?? 0, 0);

    server = fakeServer([weather]);
    await hub.reload();
    await connected(hub, "weather");
    assert.equal(hub.extensions()[0]?.tools?.length, 1);
  });
});

test("save rewrites one server's entry and reconnects only it; the others stay connected", async () => {
  const opened: string[] = [];
  const servers = {
    get weather() {
      opened.push("weather");
      return fakeServer([weather]);
    },
    get docs() {
      opened.push("docs");
      return fakeServer([weather]);
    },
  };
  const config = {
    $comment: "preserve",
    mcpServers: { weather: { command: "w" }, docs: { url: "https://docs.example/mcp" } },
  };
  await withHub(config, servers, async (hub) => {
    await connected(hub, "weather");
    await connected(hub, "docs");

    await hub.save("docs", { url: "https://docs.example/mcp", exposure: "direct" });
    await connected(hub, "docs");
    assert.deepEqual(opened, ["weather", "docs", "docs"]);
    assert.deepEqual(
      hub.status().map((s) => [s.name, s.state, s.exposure]),
      [
        ["weather", "connected", "deferred"],
        ["docs", "connected", "direct"],
      ],
    );
    const entries = await hub.entries();
    assert.deepEqual(entries.docs, { url: "https://docs.example/mcp", exposure: "direct" });

    await hub.save("docs", undefined);
    assert.deepEqual(
      hub.status().map((s) => s.name),
      ["weather"],
    );
    assert.deepEqual(Object.keys(await hub.entries()), ["weather"]);

    await assert.rejects(hub.save("bad name", { command: "x" }), /mcp\.json/);
    await assert.rejects(hub.save("x", { command: "x", exposure: "loud" }), /exposure/);
    assert.deepEqual(Object.keys(await hub.entries()), ["weather"]);
  });
});
