import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresWebDist } from "./dev.ts";

test("requiresWebDist only covers launch, start, and web", () => {
  assert.equal(requiresWebDist([]), true);
  assert.equal(requiresWebDist(["start"]), true);
  assert.equal(requiresWebDist(["web", "--open"]), true);
  assert.equal(requiresWebDist(["stop"]), false);
  assert.equal(requiresWebDist(["status"]), false);
  assert.equal(requiresWebDist(["--help"]), false);
  assert.equal(requiresWebDist(["build"]), false);
});
