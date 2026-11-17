import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { resolveInside } from "./paths.ts";

const root = resolve("memory-root");

test("目录内的相对路径可以解析", () => {
  assert.equal(resolveInside(root, "MEMORY.md"), join(root, "MEMORY.md"));
  assert.equal(resolveInside(root, "topics/sim.md"), join(root, "topics", "sim.md"));
});

test("越界路径一律拒绝", () => {
  for (const path of ["../secret", "topics/../../x", resolve("elsewhere"), "."]) {
    assert.throws(() => resolveInside(root, path), /之内/, path);
  }
});
