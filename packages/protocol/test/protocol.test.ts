import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "@earendil-works/pi-schema";
import {
  HealthResponseSchema,
  PROTOCOL_VERSION,
  TicketIdSchema,
  WorkerIdSchema,
} from "../src/index.ts";

test("protocol schemas validate canonical IDs and health payloads", () => {
  const checkWorker = compile(WorkerIdSchema);
  const checkTicket = compile(TicketIdSchema);
  const checkHealth = compile(HealthResponseSchema);

  assert.equal(checkWorker.check("w1"), true);
  assert.equal(checkWorker.check("w0"), false);
  assert.equal(checkTicket.check("t12"), true);
  assert.equal(checkTicket.check("x1"), false);
  assert.equal(
    checkHealth.check({ ok: true, protocolVersion: PROTOCOL_VERSION, engineVersion: "0.0.1" }),
    true,
  );
});
