import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyedSerialQueue } from "../src/serial-queue.ts";
import { BufferedSessionStream } from "../src/session-stream.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("BufferedSessionStream replays history, isolates subscriber errors, and clears subscribers on terminal", () => {
  const stream = new BufferedSessionStream<string>();
  stream.emit("f1");
  stream.emit("f2");

  const seenA: string[] = [];
  const unsubA = stream.subscribe((frame) => seenA.push(frame));
  assert.deepEqual(seenA, ["f1", "f2"]);

  stream.subscribe((frame) => {
    if (frame === "f3" || frame === "done") {
      throw new Error("bad subscriber");
    }
  });

  const seenB: string[] = [];
  stream.subscribe((frame) => seenB.push(frame));
  assert.deepEqual(seenB, ["f1", "f2"]);

  stream.emit("f3");
  assert.deepEqual(seenA, ["f1", "f2", "f3"]);
  assert.deepEqual(seenB, ["f1", "f2", "f3"]);

  unsubA();
  stream.complete("done");
  assert.equal(stream.terminal, true);
  assert.deepEqual(seenA, ["f1", "f2", "f3"]);
  assert.deepEqual(seenB, ["f1", "f2", "f3", "done"]);

  const seenAfter: string[] = [];
  const unsubAfter = stream.subscribe((frame) => seenAfter.push(frame));
  assert.deepEqual(seenAfter, ["f1", "f2", "f3", "done"]);
  unsubAfter();

  stream.emit("ignored");
  stream.complete("ignored-terminal");
  assert.deepEqual(stream.history, ["f1", "f2", "f3", "done"]);
});

test("BufferedSessionStream expires after retentionMs and cancels timer on cancelCleanup/dispose", async () => {
  let expiredCount = 0;
  const expiring = new BufferedSessionStream<string>({
    retentionMs: 25,
    onExpire: () => {
      expiredCount += 1;
    },
  });
  expiring.complete("done");
  await delay(80);
  assert.equal(expiredCount, 1);

  let disposedExpired = 0;
  const disposed = new BufferedSessionStream<string>({
    retentionMs: 25,
    onExpire: () => {
      disposedExpired += 1;
    },
  });
  disposed.complete("done");
  disposed.dispose();
  await delay(80);
  assert.equal(disposedExpired, 0);

  let cancelledExpired = 0;
  const cancelled = new BufferedSessionStream<string>({
    retentionMs: 25,
    onExpire: () => {
      cancelledExpired += 1;
    },
  });
  const seenOnCancel: string[] = [];
  cancelled.subscribe((frame) => seenOnCancel.push(frame));
  cancelled.cancelCleanup();
  cancelled.complete("cancelled");
  assert.deepEqual(seenOnCancel, ["cancelled"]);
  await delay(80);
  assert.equal(cancelledExpired, 0);
});

test("KeyedSerialQueue serializes same-key tasks across failures and runs distinct keys concurrently", async () => {
  const queue = new KeyedSerialQueue();
  const events: string[] = [];

  const t1 = queue.enqueue("a", async () => {
    events.push("start:a1");
    await delay(30);
    events.push("end:a1");
    return 1;
  });

  const t2 = queue.enqueue("a", async () => {
    events.push("start:a2");
    await delay(10);
    events.push("err:a2");
    throw new Error("boom");
  });

  const t3 = queue.enqueue("a", async () => {
    events.push("start:a3");
    await delay(5);
    events.push("end:a3");
    return 3;
  });

  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const slow = queue.enqueue("b", async () => {
    events.push("start:b");
    await slowGate;
    events.push("end:b");
    return "b";
  });

  const fast = queue.enqueue("c", async () => {
    events.push("fast:c");
    return "c";
  });

  assert.equal(await fast, "c");
  assert.ok(events.includes("fast:c"));
  assert.equal(events.includes("end:b"), false);

  assert.equal(await t1, 1);
  await assert.rejects(t2, /boom/);
  assert.equal(await t3, 3);
  await queue.drain("a");

  assert.deepEqual(
    events.filter((e) => e.includes(":a")),
    ["start:a1", "end:a1", "start:a2", "err:a2", "start:a3", "end:a3"],
  );

  releaseSlow();
  await queue.drainAll();
  assert.equal(await slow, "b");
  assert.equal(events.includes("end:b"), true);
});
