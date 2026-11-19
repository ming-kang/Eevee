import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardView } from "../api/contract.ts";
import { BoardFeed } from "./board-feed.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const board = (marker: number): BoardView => ({
  tickets: [],
  openQuestions: [
    {
      id: `q${marker}` as never,
      items: [{ text: `q${marker}`, options: ["a", "b"] }],
      askedAt: marker,
    },
  ],
  router: { running: false },
});

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("multiple invalidate() calls coalesce into one notification, and throwing listeners do not block others", async () => {
  const feed = new BoardFeed(async () => board(0));
  let countA = 0;
  let countB = 0;
  feed.subscribe(() => {
    countA += 1;
    throw new Error("boom");
  });
  feed.subscribe(() => {
    countB += 1;
  });

  feed.invalidate();
  feed.invalidate();
  feed.invalidate();
  assert.deepEqual([countA, countB], [0, 0]);

  await nextTick();
  assert.deepEqual([countA, countB], [1, 1]);

  feed.invalidate();
  await nextTick();
  assert.deepEqual([countA, countB], [2, 2]);
  feed.close();
});

test("read() never notifies subscribers and reuses cache or in-flight work for the same generation", async () => {
  let builds = 0;
  const d = deferred<BoardView>();
  const feed = new BoardFeed(() => {
    builds += 1;
    return d.promise;
  });
  let notifications = 0;
  feed.subscribe(() => {
    notifications += 1;
  });

  const p1 = feed.read();
  const p2 = feed.read();
  assert.equal(builds, 1);

  d.resolve(board(1));
  const [v1, v2] = await Promise.all([p1, p2]);
  assert.equal(v1.openQuestions[0]?.id, "q1");
  assert.equal(v2.openQuestions[0]?.id, "q1");

  const v3 = await feed.read();
  assert.equal(builds, 1);
  assert.equal(v3.openQuestions[0]?.id, "q1");

  await nextTick();
  assert.equal(notifications, 0);
  feed.close();
});

test("invalidating during an in-flight build starts a new build on the next read()", async () => {
  const pending: Deferred<BoardView>[] = [];
  const feed = new BoardFeed(() => {
    const d = deferred<BoardView>();
    pending.push(d);
    return d.promise;
  });

  const first = feed.read();
  assert.equal(pending.length, 1);

  feed.invalidate();
  const second = feed.read();
  assert.equal(pending.length, 2);

  pending[0]?.resolve(board(1));
  pending[1]?.resolve(board(2));
  assert.equal((await first).openQuestions[0]?.id, "q1");
  assert.equal((await second).openQuestions[0]?.id, "q2");
  feed.close();
});

test("a slow older build finishing after a newer build never overwrites the newer cache", async () => {
  const pending: Deferred<BoardView>[] = [];
  const feed = new BoardFeed(() => {
    const d = deferred<BoardView>();
    pending.push(d);
    return d.promise;
  });

  const slowOld = feed.read();
  feed.invalidate();
  const fastNew = feed.read();
  assert.equal(pending.length, 2);

  pending[1]?.resolve(board(2));
  assert.equal((await fastNew).openQuestions[0]?.id, "q2");

  pending[0]?.resolve(board(1));
  assert.equal((await slowOld).openQuestions[0]?.id, "q1");

  const cached = await feed.read();
  assert.equal(pending.length, 2);
  assert.equal(cached.openQuestions[0]?.id, "q2");
  feed.close();
});
