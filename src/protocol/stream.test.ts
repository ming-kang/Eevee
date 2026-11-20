import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStreamRequest, STREAM_PROTOCOL } from "./stream.ts";

test("v2 engine watches need no project and cannot request conversation entries", () => {
  assert.equal(STREAM_PROTOCOL, "eevee.v2");
  assert.deepEqual(parseStreamRequest({ type: "watch", id: "e1", topic: { kind: "engine" } }), {
    type: "watch",
    id: "e1",
    topic: { kind: "engine" },
  });
  for (const [request, field] of [
    [{ type: "watch", id: "e1", topic: { kind: "engine", project: "p1" } }, "topic.project"],
    [{ type: "watch", id: "e1", topic: { kind: "engine", ticket: "t1" } }, "topic.ticket"],
    [{ type: "entries", id: "e1", topic: { kind: "engine" }, query: {}, limit: 10 }, "topic.kind"],
    [{ type: "watch", id: "b1", topic: { kind: "board" } }, "topic.project"],
    [
      { type: "watch", id: "c1", topic: { kind: "conversation", project: "p1", ticket: "t0" } },
      "topic.ticket",
    ],
    [{}, "type"],
  ] as const) {
    assert.throws(() => parseStreamRequest(request), { problem: { code: "invalid", field } });
  }
});
