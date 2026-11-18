import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { resolveCapability, roleChange } from "./role.ts";
import { workerRole } from "./worker.ts";

const tool = (name: string, extra: { deferred?: true; callers?: readonly ["tools"] } = {}) =>
  defineTool({
    name,
    description: name,
    parameters: obj({}),
    replay: "safe",
    ...extra,
    execute: async () => ({ output: [] }),
  });

function registry() {
  const r = createRegistry();
  r.install(defineExtension({ name: "plain", tools: [tool("a")] }));
  r.install(defineExtension({ name: "lazy", tools: [tool("b", { deferred: true })] }));
  r.install(defineExtension({ name: "scripted", tools: [tool("c", { callers: ["tools"] })] }));
  r.install(defineExtension({ name: "tool-search" }));
  r.install(defineExtension({ name: "codemode" }));
  return r.snapshot();
}

const names = (capability: ReturnType<typeof resolveCapability>) =>
  capability.extensions.map((e) => e.name);

test("按名字解析扩展，去重，没安装的单独列出", () => {
  const capability = resolveCapability(registry(), ["plain", "gone", "plain"]);
  assert.deepEqual(names(capability), ["plain"]);
  assert.deepEqual(capability.missing, ["gone"]);
});

test("有延迟加载的工具时带上 tool-search，只给脚本用的工具带上 codemode", () => {
  assert.deepEqual(names(resolveCapability(registry(), ["lazy"])), ["lazy", "tool-search"]);
  assert.deepEqual(names(resolveCapability(registry(), ["scripted"])), ["scripted", "codemode"]);
  assert.deepEqual(names(resolveCapability(registry(), ["codemode", "scripted"])), [
    "codemode",
    "scripted",
  ]);
});

test("应用角色时选中全部扩展的全部工具，不动 tool_search 加载过的工具", () => {
  const change = roleChange(workerRole, resolveCapability(registry(), ["plain"]), {
    cwd: "/work",
    maxTurns: 40,
  });
  assert.ok(Array.isArray(change.extensions));
  assert.deepEqual(
    (change.extensions as readonly { name: string }[]).map((e) => e.name),
    ["plain"],
  );
  assert.equal(change.tools, null);
  assert.equal("modelTools" in change, false);
  assert.equal(change.maxTurns, 40);
  // Without a choice the stored model is cleared, not left behind.
  assert.deepEqual([change.model, change.thinkingLevel], [null, null]);
  const model = { provider: "faux", modelId: "brain" };
  const thinking = roleChange(
    workerRole,
    { extensions: [], missing: [] },
    {
      cwd: "/",
      model: { ...model, thinkingLevel: "high" },
    },
  );
  assert.deepEqual([thinking.model, thinking.thinkingLevel], [model, "high"]);
  // A choice without a level clears the one stored before.
  const plain = roleChange(workerRole, { extensions: [], missing: [] }, { cwd: "/", model });
  assert.deepEqual([plain.model, plain.thinkingLevel], [model, null]);
  assert.equal(
    roleChange(workerRole, { extensions: [], missing: [] }, { cwd: "/" }).maxTurns,
    null,
  );
});
