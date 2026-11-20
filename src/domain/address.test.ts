import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, AddressError, formatAddress, parseAddress } from "./address.ts";

const roundTrips: [string, Address][] = [
  ["ticket://", { kind: "tickets" }],
  ["ticket://t12", { kind: "ticket", id: "t12" }],
  ["report://t3", { kind: "report", ticketId: "t3" }],
  ["report://t3#2", { kind: "report", ticketId: "t3", seq: 2 }],
  ["transcript://3", { kind: "transcript", conversationId: 3 }],
  ["transcript://3/42", { kind: "transcript", conversationId: 3, entryId: 42 }],
  ["memory://project/optics-sim.md", { kind: "memory", scope: "project", file: "optics-sim.md" }],
  ["memory://global/MEMORY.md", { kind: "memory", scope: "global", file: "MEMORY.md" }],
  ["job://j7", { kind: "job", id: "j7" }],
  ["models://", { kind: "models" }],
  ["src/main.ts", { kind: "file", path: "src/main.ts" }],
];

test("an address parses and formats back unchanged", () => {
  for (const [raw, address] of roundTrips) {
    assert.deepEqual(parseAddress(raw), address, raw);
    assert.equal(formatAddress(address), raw);
  }
});

test("a Windows drive path is a file, not a scheme", () => {
  assert.deepEqual(parseAddress("C:\\work\\paper.tex"), {
    kind: "file",
    path: "C:\\work\\paper.tex",
  });
});

test("an invalid address raises a clear error", () => {
  for (const raw of [
    "ticket://12",
    "transcript://conv-1",
    "report://t1#0",
    "memory://repo/x.md",
    "job://7",
    "foo://x",
  ]) {
    assert.throws(() => parseAddress(raw), AddressError, raw);
  }
});
