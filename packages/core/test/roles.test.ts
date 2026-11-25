import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_EXTENSIONS } from "@eevee/agent";
import { MEMORY_EXTENSION } from "@eevee/memory";
import {
  ROUTER_COLLAB_TOOLS,
  ROUTER_EXTENSIONS,
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
