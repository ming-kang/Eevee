import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { BoardView } from "../api/contract.ts";
import { BoardFeed, type BoardListener } from "./board-feed.ts";

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

const marker = (view: BoardView | undefined) => view?.openQuestions[0]?.id;

/** A feed whose builds the test finishes one at a time; each returns the board as it was when the build began. */
function manualFeed(initial = 0) {
  let state = initial;
  const builds: { state: number; finish(): void; fail(error: unknown): void }[] = [];
  let running = 0;
  let overlapped = false;
  const feed = new BoardFeed(() => {
    running += 1;
    overlapped ||= running > 1;
    const seen = state;
    return new Promise<BoardView>((resolve, reject) => {
      builds.push({
        state: seen,
        finish: () => {
          running -= 1;
          resolve(board(seen));
        },
        fail: (error) => {
          running -= 1;
          reject(error);
        },
      });
    });
  });
  return {
    feed,
    builds,
    overlapped: () => overlapped,
    set(next: number) {
      state = next;
      feed.invalidate();
    },
  };
}

function recorder() {
  const views: (string | undefined)[] = [];
  const errors: unknown[] = [];
  const listener: BoardListener = {
    view: (view) => views.push(marker(view)),
    failed: (error) => errors.push(error),
  };
  return { listener, views, errors };
}

async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await nextTurn();
}

test("a subscriber hears the current board, then a burst of changes as one new board", async () => {
  const { feed, builds, set } = manualFeed();
  const heard = recorder();
  feed.subscribe(heard.listener);
  await settle();
  builds.shift()?.finish();
  await settle();
  assert.deepEqual(heard.views, ["q0"]);

  set(1);
  set(2);
  set(3);
  await settle();
  assert.equal(builds.length, 1);
  builds.shift()?.finish();
  await settle();
  assert.deepEqual(heard.views, ["q0", "q3"]);
  await feed.close();
});

test("read() reuses the last snapshot until the board changes, and joins the build under way", async () => {
  const { feed, builds, set } = manualFeed();
  const first = feed.read();
  const second = feed.read();
  assert.equal(builds.length, 1);
  builds.shift()?.finish();
  assert.deepEqual([marker(await first), marker(await second)], ["q0", "q0"]);
  assert.equal(marker(await feed.read()), "q0");
  assert.equal(builds.length, 0);

  set(1);
  const third = feed.read();
  await settle();
  builds.shift()?.finish();
  assert.equal(marker(await third), "q1");
  await feed.close();
});

test("a read that comes after a change waits for a build that began after it", async () => {
  const { feed, builds, set, overlapped } = manualFeed();
  const before = feed.read();
  set(1);
  const after = feed.read();
  await settle();
  assert.equal(builds.length, 1, "builds never run side by side");
  builds.shift()?.finish();
  assert.equal(marker(await before), "q0");
  await settle();
  builds.shift()?.finish();
  assert.equal(marker(await after), "q1");
  assert.equal(overlapped(), false);
  await feed.close();
});

test("subscribers never hear an older board after a newer one, whatever order the work finishes in", async () => {
  const { feed, builds, set, overlapped } = manualFeed();
  const heard = recorder();
  feed.subscribe(heard.listener);
  await settle();
  builds.shift()?.finish();
  await settle();

  set(1);
  await settle();
  set(2);
  const read = feed.read();
  for (;;) {
    await settle();
    const build = builds.pop();
    if (build === undefined) break;
    build.finish();
  }
  assert.equal(marker(await read), "q2");
  assert.deepEqual(heard.views, ["q0", "q1", "q2"]);
  assert.equal(overlapped(), false);
  await feed.close();
});

test("a board whose content did not change is not delivered again", async () => {
  const { feed, builds } = manualFeed();
  const heard = recorder();
  feed.subscribe(heard.listener);
  await settle();
  builds.shift()?.finish();
  await settle();
  const before = await feed.read();

  feed.invalidate();
  await settle();
  builds.shift()?.finish();
  await settle();
  assert.deepEqual(heard.views, ["q0"]);
  assert.equal(await feed.read(), before);
  await feed.close();
});

test("a failed build is told to subscribers, a throwing listener does not silence the others, and the next change recovers", async (t) => {
  t.mock.method(console, "error", () => {});
  const { feed, builds, set } = manualFeed();
  const heard = recorder();
  feed.subscribe({
    view: () => {
      throw new Error("listener boom");
    },
    failed: () => {
      throw new Error("listener boom");
    },
  });
  feed.subscribe(heard.listener);
  await settle();
  builds.shift()?.fail(new Error("build boom"));
  await settle();
  assert.equal((heard.errors[0] as Error).message, "build boom");

  set(1);
  await settle();
  builds.shift()?.finish();
  await settle();
  assert.deepEqual(heard.views, ["q1"]);
  await feed.close();
});

test("close() waits for the delivery under way, and nothing is delivered after it", async () => {
  const { feed, builds, set } = manualFeed();
  const heard = recorder();
  feed.subscribe(heard.listener);
  await settle();
  let closed = false;
  const closing = feed.close().then(() => {
    closed = true;
  });
  await settle();
  assert.equal(closed, false);
  builds.shift()?.finish();
  await closing;
  set(1);
  await settle();
  assert.deepEqual(heard.views, []);
  assert.equal(builds.length, 0);
});
