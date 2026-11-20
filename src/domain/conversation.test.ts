import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConversationRef } from "./conversation.ts";
import { ProblemError } from "./problem.ts";

test("conversation references name the router or a positive ticket id", () => {
  assert.equal(parseConversationRef("router"), "router");
  assert.equal(parseConversationRef("t123"), "t123");
  for (const value of ["", "t0", "t01", "t-1", "worker", "t1/../router", " router "]) {
    assert.throws(() => parseConversationRef(value), ProblemError);
  }
});
