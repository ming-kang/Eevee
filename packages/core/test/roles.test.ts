import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { AGENT_EXTENSIONS, BASE_EXTENSION, MCP_SERVER_EXTENSION_PREFIX } from "@eevee/agent";
import { MEMORY_EXTENSION } from "@eevee/memory";
import {
  parseModelSpec,
  ROUTER_COLLAB_TOOLS,
  ROUTER_EXTENSION,
  ROUTER_EXTENSIONS,
  resolveRoleExtensions,
  WORKER_COLLAB_TOOLS,
  WORKER_EXTENSIONS,
} from "../src/index.ts";

test("Router uses readonly tools and binary-forest memory without coding tools or cached compaction", () => {
  const router = new Set<string>(ROUTER_EXTENSIONS);
  assert.ok(router.has(AGENT_EXTENSIONS.readonlyTools));
  assert.ok(router.has(AGENT_EXTENSIONS.shellPaths));
  assert.ok(router.has(AGENT_EXTENSIONS.codemode));
  assert.ok(router.has(AGENT_EXTENSIONS.toolSearch));
  assert.ok(router.has(AGENT_EXTENSIONS.mcp));
  assert.ok(router.has(MEMORY_EXTENSION));

  assert.equal(router.has(AGENT_EXTENSIONS.codingTools), false);
  assert.equal(router.has(AGENT_EXTENSIONS.tasks), false);
  assert.equal(router.has(AGENT_EXTENSIONS.cachedCompaction), false);
  assert.ok(ROUTER_COLLAB_TOOLS.includes("ask_user"));
});

test("Worker uses coding tools, tasks, cached compaction, and message_router without readonly tools or forest memory", () => {
  const worker = new Set<string>(WORKER_EXTENSIONS);
  assert.ok(worker.has(AGENT_EXTENSIONS.codingTools));
  assert.ok(worker.has(AGENT_EXTENSIONS.shellPaths));
  assert.ok(worker.has(AGENT_EXTENSIONS.tasks));
  assert.ok(worker.has(AGENT_EXTENSIONS.codemode));
  assert.ok(worker.has(AGENT_EXTENSIONS.toolSearch));
  assert.ok(worker.has(AGENT_EXTENSIONS.mcp));
  assert.ok(worker.has(AGENT_EXTENSIONS.cachedCompaction));

  assert.equal(worker.has(AGENT_EXTENSIONS.readonlyTools), false);
  assert.equal(worker.has(MEMORY_EXTENSION), false);
  assert.deepEqual(WORKER_COLLAB_TOOLS, ["message_router"]);
});

test("parseModelSpec splits provider from model id and validates the catalog", () => {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);

  assert.deepEqual(parseModelSpec(`${faux.provider.id}/faux-1`, models), {
    provider: faux.provider.id,
    modelId: "faux-1",
  });
  assert.equal(parseModelSpec("missing-slash", models), undefined);
  assert.equal(parseModelSpec(`${faux.provider.id}/missing`, models), undefined);
  assert.equal(parseModelSpec(`missing/faux-1`, models), undefined);
});

test("resolveRoleExtensions uses installed base, role, and MCP server extensions", () => {
  const registry = createRegistry();
  for (const name of [
    BASE_EXTENSION,
    ...ROUTER_EXTENSIONS,
    `${MCP_SERVER_EXTENSION_PREFIX}alpha`,
  ]) {
    registry.install(defineExtension({ name }));
  }

  assert.deepEqual(
    resolveRoleExtensions("router", registry.snapshot()).map((extension) => extension.name),
    [BASE_EXTENSION, ...ROUTER_EXTENSIONS, `${MCP_SERVER_EXTENSION_PREFIX}alpha`],
  );

  const withoutMcpHub = createRegistry();
  for (const name of [BASE_EXTENSION, ROUTER_EXTENSION, `${MCP_SERVER_EXTENSION_PREFIX}alpha`]) {
    withoutMcpHub.install(defineExtension({ name }));
  }
  assert.deepEqual(
    resolveRoleExtensions("router", withoutMcpHub.snapshot()).map((extension) => extension.name),
    [BASE_EXTENSION, ROUTER_EXTENSION],
  );
});
