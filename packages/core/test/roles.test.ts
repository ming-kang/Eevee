import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { AGENT_EXTENSIONS, BASE_EXTENSION, MCP_SERVER_EXTENSION_PREFIX } from "@eevee/agent";
import { MEMORY_EXTENSION } from "@eevee/memory";
import {
  DEFAULT_ROUTER_INSTRUCTIONS,
  DEFAULT_WORKER_INSTRUCTIONS,
  parseModelSpec,
  ROUTER_COLLAB_TOOLS,
  ROUTER_EXTENSION,
  ROUTER_EXTENSIONS,
  ROUTER_PREAMBLE,
  resolveRoleExtensions,
  resolveRoleToolFilters,
  WORKER_COLLAB_TOOLS,
  WORKER_EXTENSION,
  WORKER_EXTENSIONS,
  WORKER_PREAMBLE,
} from "../src/index.ts";

function dummyTool(name: string) {
  return defineTool({
    name,
    description: name,
    parameters: obj({}),
    execute: async () => ({ output: [] }),
  });
}

function policyRegistry() {
  const registry = createRegistry();
  registry.install(defineExtension({ name: BASE_EXTENSION }));
  registry.install(
    defineExtension({
      name: AGENT_EXTENSIONS.readonlyTools,
      tools: ["read", "ls", "find", "grep", "tool_search"].map(dummyTool),
    }),
  );
  registry.install(
    defineExtension({
      name: AGENT_EXTENSIONS.codingTools,
      tools: ["read", "write", "edit", "bash", "powershell", "ls", "find", "grep"].map(dummyTool),
    }),
  );
  registry.install(
    defineExtension({ name: AGENT_EXTENSIONS.codemode, tools: [dummyTool("codemode")] }),
  );
  return registry;
}

function removedToolNames(filter: ReturnType<typeof resolveRoleToolFilters>["tools"]): string[] {
  return (filter?.remove ?? []).map((tool) => tool.name);
}

test("Router uses readonly tools and binary-forest memory in prompt-cache extension order", () => {
  assert.deepEqual(ROUTER_EXTENSIONS, [
    AGENT_EXTENSIONS.readonlyTools,
    AGENT_EXTENSIONS.shellPaths,
    AGENT_EXTENSIONS.codemode,
    AGENT_EXTENSIONS.toolSearch,
    MEMORY_EXTENSION,
    AGENT_EXTENSIONS.mcp,
    ROUTER_EXTENSION,
  ]);
  const router = new Set<string>(ROUTER_EXTENSIONS);
  assert.equal(router.has(AGENT_EXTENSIONS.codingTools), false);
  assert.equal(router.has(AGENT_EXTENSIONS.tasks), false);
  assert.equal(router.has(AGENT_EXTENSIONS.cachedCompaction), false);
  assert.ok(ROUTER_COLLAB_TOOLS.includes("ask_user"));
});

test("Worker uses coding tools, tasks, cached compaction, and message_router with mcp last", () => {
  assert.deepEqual(WORKER_EXTENSIONS, [
    AGENT_EXTENSIONS.codingTools,
    AGENT_EXTENSIONS.shellPaths,
    AGENT_EXTENSIONS.tasks,
    AGENT_EXTENSIONS.codemode,
    AGENT_EXTENSIONS.toolSearch,
    AGENT_EXTENSIONS.cachedCompaction,
    WORKER_EXTENSION,
    AGENT_EXTENSIONS.mcp,
  ]);
  const worker = new Set<string>(WORKER_EXTENSIONS);
  assert.equal(worker.has(AGENT_EXTENSIONS.readonlyTools), false);
  assert.equal(worker.has(MEMORY_EXTENSION), false);
  assert.deepEqual(WORKER_COLLAB_TOOLS, ["message_router"]);
});

test("role preambles define identity concisely and default instructions omit redundant identity", () => {
  assert.ok(ROUTER_PREAMBLE.startsWith("You are Eevee Router,"));
  assert.ok(WORKER_PREAMBLE.startsWith("You are an Eevee Worker,"));
  assert.equal(DEFAULT_ROUTER_INSTRUCTIONS.includes("You are"), false);
  assert.equal(DEFAULT_WORKER_INSTRUCTIONS.includes("You are"), false);
  assert.ok(DEFAULT_ROUTER_INSTRUCTIONS.includes("spawn_worker"));
  assert.ok(DEFAULT_WORKER_INSTRUCTIONS.includes("message_router"));
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
  assert.equal(parseModelSpec("missing/faux-1", models), undefined);
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

test("resolveRoleExtensions omits codemode only when policy mode is off", () => {
  const registry = policyRegistry();
  const withoutCodemode = resolveRoleExtensions("worker", registry.snapshot(), {
    codemode: { mode: "off" },
  });
  assert.equal(
    withoutCodemode.some((extension) => extension.name === AGENT_EXTENSIONS.codemode),
    false,
  );
  assert.equal(
    resolveRoleExtensions("worker", registry.snapshot(), {
      codemode: { mode: "on" },
    }).some((extension) => extension.name === AGENT_EXTENSIONS.codemode),
    true,
  );
  assert.equal(
    resolveRoleExtensions("worker", registry.snapshot()).some(
      (extension) => extension.name === AGENT_EXTENSIONS.codemode,
    ),
    true,
  );
});

test("resolveRoleToolFilters applies Worker defaults and per-tool overrides", () => {
  const registry = policyRegistry();
  const extensions = resolveRoleExtensions("worker", registry.snapshot());
  const defaults = resolveRoleToolFilters("worker", extensions);
  assert.deepEqual(removedToolNames(defaults.tools), ["powershell", "ls", "find", "grep"]);
  assert.equal(defaults.modelTools, null);

  const powerShellWithoutBash = resolveRoleToolFilters("worker", extensions, {
    worker: { powershell: true, bash: false },
  });
  assert.deepEqual(removedToolNames(powerShellWithoutBash.tools), ["bash", "ls", "find", "grep"]);

  const withGrep = resolveRoleToolFilters("worker", extensions, {
    worker: { grep: true },
  });
  assert.deepEqual(removedToolNames(withGrep.tools), ["powershell", "ls", "find"]);
});

test("resolveRoleToolFilters applies Router overrides and codemode-only model filtering", () => {
  const registry = policyRegistry();
  const routerExtensions = resolveRoleExtensions("router", registry.snapshot());
  const router = resolveRoleToolFilters("router", routerExtensions, {
    router: { ls: false },
  });
  assert.deepEqual(removedToolNames(router.tools), ["ls"]);
  assert.equal(router.modelTools, null);

  const workerExtensions = resolveRoleExtensions("worker", registry.snapshot(), {
    codemode: { mode: "only" },
  });
  const only = resolveRoleToolFilters("worker", workerExtensions, {
    codemode: { mode: "only" },
  });
  assert.deepEqual(removedToolNames(only.modelTools), ["read", "write", "edit", "bash"]);
  assert.deepEqual(removedToolNames(only.tools), ["powershell", "ls", "find", "grep"]);

  const offExtensions = resolveRoleExtensions("worker", registry.snapshot(), {
    codemode: { mode: "off" },
  });
  assert.equal(
    resolveRoleToolFilters("worker", offExtensions, { codemode: { mode: "off" } }).modelTools,
    null,
  );
});
