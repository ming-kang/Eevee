import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { resolveInside } from "./paths.ts";

const root = resolve("memory-root");

test("a relative path inside the directory resolves", () => {
  assert.equal(resolveInside(root, "MEMORY.md"), join(root, "MEMORY.md"));
  assert.equal(resolveInside(root, "topics/sim.md"), join(root, "topics", "sim.md"));
});

test("a path outside the directory is always refused", () => {
  for (const path of ["../secret", "topics/../../x", resolve("elsewhere"), "."]) {
    assert.throws(() => resolveInside(root, path), /must stay inside/, path);
  }
});
