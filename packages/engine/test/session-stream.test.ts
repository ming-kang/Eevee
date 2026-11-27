import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineError } from "../src/engine-error.ts";
import { KeyedSerialQueue } from "../src/serial-queue.ts";
import { KeyedSessionRegistry, type ManagedSessionEntry } from "../src/session-registry.ts";
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

test("KeyedSessionRegistry handles scoped lookup, retention expiry, serialized starts, cancelWhere, and close", async () => {
  type TestSession = ManagedSessionEntry<string> & {
    readonly scope: string;
    cancelled: boolean;
    finish: (frame: string) => void;
  };

  const registry = new KeyedSessionRegistry<TestSession, string>({ retentionMs: 25 });
  const events: string[] = [];

  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });

  const makeSession = (
    sessionId: string,
    scope: string,
    opts?: { autoComplete?: boolean },
  ): TestSession => {
    const stream = registry.createStream(() => sessionId);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    stream.track(done);
    const entry: TestSession = {
      sessionId,
      scope,
      stream,
      cancelled: false,
      finish: (frame) => {
        stream.complete(frame);
        resolveDone();
      },
    };
    if (opts?.autoComplete) {
      entry.finish("auto");
    }
    return entry;
  };

  // Same-key starts serialize; distinct-key starts proceed concurrently
  const s1Promise = registry.start("key-a", async () => {
    events.push("start:a1");
    await gate;
    events.push("end:a1");
    return makeSession("s1", "scope-a");
  });
  const s2Promise = registry.start("key-a", () => {
    events.push("start:a2");
    return makeSession("s2", "scope-a");
  });
  const sOther = await registry.start("key-b", () => {
    events.push("start:b");
    return makeSession("s-other", "scope-b");
  });

  assert.equal(sOther.sessionId, "s-other");
  assert.deepEqual(events, ["start:a1", "start:b"]);

  resolveGate();
  const [s1, s2] = await Promise.all([s1Promise, s2Promise]);
  assert.deepEqual(events, ["start:a1", "start:b", "end:a1", "start:a2"]);

  // Scoped lookup enforces predicate & custom error
  assert.equal(
    registry.require(
      s1.sessionId,
      (entry) => entry.scope === "scope-a",
      () => new EngineError(404, "not_found", "missing"),
    ),
    s1,
  );
  assert.throws(
    () =>
      registry.require(
        s1.sessionId,
        (entry) => entry.scope === "wrong",
        () => new EngineError(404, "custom_not_found", "wrong scope"),
      ),
    (err: unknown) => err instanceof EngineError && err.code === "custom_not_found",
  );

  // Retention expiry deletes terminal sessions from registry
  const expiring = await registry.start("key-exp", () =>
    makeSession("s-exp", "scope-exp", { autoComplete: true }),
  );
  assert.equal(registry.size, 4);
  await delay(80);
  assert.throws(
    () =>
      registry.require(
        expiring.sessionId,
        () => true,
        () => new EngineError(404, "expired", "expired"),
      ),
    /expired/,
  );

  // cancelWhere drains matching non-terminal sessions without cancelling others
  await registry.cancelWhere(
    (entry) => entry.sessionId === "s1",
    (entry) => {
      entry.cancelled = true;
      entry.finish("cancelled");
    },
  );
  assert.equal(s1.cancelled, true);
  assert.equal(s2.cancelled, false);
  assert.equal(sOther.cancelled, false);

  // close() drains mid-flight starts, rejects queued starts, cancels active sessions, clears registry, and rejects new starts
  let enteredClosingStart!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredClosingStart = resolve;
  });
  let releaseClosingStart!: () => void;
  const closingStartGate = new Promise<void>((resolve) => {
    releaseClosingStart = resolve;
  });
  const inFlightStart = registry.start("key-c", async () => {
    enteredClosingStart();
    await closingStartGate;
    return makeSession("s-inflight", "scope-c");
  });
  await entered;
  const queuedBehindInFlight = registry.start("key-c", () => makeSession("s-queued", "scope-c"));

  const closing = registry.close((entry) => {
    entry.cancelled = true;
    entry.finish("closed");
  });
  releaseClosingStart();
  const inflight = await inFlightStart;
  await closing;

  await assert.rejects(
    queuedBehindInFlight,
    (err: unknown) =>
      err instanceof EngineError && err.status === 503 && err.code === "engine_closed",
  );
  assert.equal(s2.cancelled, true);
  assert.equal(sOther.cancelled, true);
  assert.equal(inflight.cancelled, true);
  assert.equal(registry.size, 0);
  assert.equal(registry.closed, true);

  await assert.rejects(
    registry.start("key-d", () => makeSession("s-after", "scope-d")),
    (err: unknown) =>
      err instanceof EngineError && err.status === 503 && err.code === "engine_closed",
  );
});
