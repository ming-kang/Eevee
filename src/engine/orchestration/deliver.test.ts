import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "@earendil-works/pi-durable";
import { WorkerQueue } from "./deliver.ts";

const migrate = (pending: unknown[]) => {
  const fromVersion1 = WorkerQueue.definition.migrate;
  assert.ok(fromVersion1 !== undefined);
  return fromVersion1({ pending } as JsonObject, 1);
};

test("the queue's version 2 migration turns each stored start into the ticket that waits", () => {
  assert.deepEqual(
    migrate([
      {
        target: { kind: "ticket", id: "t3" },
        mode: "start",
        whenBusy: "followUp",
        text: "",
        requestId: "opening:t3",
      },
      { target: { kind: "ticket", id: "t7" }, mode: "start", requestId: "opening:t7" },
    ]).pending,
    [
      { ticketId: "t3", requestId: "opening:t3" },
      { ticketId: "t7", requestId: "opening:t7" },
    ],
  );
});

test("the migration drops whatever is not a queued ticket start", () => {
  assert.deepEqual(
    migrate([
      { target: { kind: "router" }, mode: "wake", requestId: "user:1" },
      { target: { kind: "ticket", id: "t2" } },
      { target: { kind: "ticket" }, requestId: "opening:t5" },
      null,
      "opening:t6",
    ]).pending,
    [],
  );
});
