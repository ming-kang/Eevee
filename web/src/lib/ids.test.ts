import assert from "node:assert/strict";
import { test } from "node:test";
import { displayId } from "./ids.ts";

test("displayId capitalizes ticket and job ids only", () => {
  assert.equal(displayId("t4"), "T4");
  assert.equal(displayId("j12"), "J12");
  assert.equal(displayId("T4"), "T4");
  assert.equal(displayId("tool"), "tool");
  assert.equal(displayId("p0494df61"), "p0494df61");
  assert.equal(displayId(""), "");
});
