import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { SerialPass } from "./serial-pass.ts";

const unexpected = (error: unknown) => assert.fail(String(error));

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

test("a burst of requests runs one pass on the next turn", async () => {
  let runs = 0;
  const pass = new SerialPass(async () => {
    runs += 1;
  }, unexpected);
  pass.request();
  pass.request();
  pass.request();
  assert.equal(runs, 0);
  await nextTurn();
  await nextTurn();
  assert.equal(runs, 1);
  await pass.close();
});

test("a request during a pass runs it once more afterwards, never alongside", async () => {
  const first = gate();
  let running = 0;
  let overlapped = false;
  let runs = 0;
  const pass = new SerialPass(async () => {
    running += 1;
    overlapped ||= running > 1;
    runs += 1;
    if (runs === 1) await first.opened;
    running -= 1;
  }, unexpected);
  pass.request();
  await nextTurn();
  pass.request();
  pass.request();
  first.open();
  for (let i = 0; i < 5; i += 1) await nextTurn();
  assert.equal(runs, 2);
  assert.equal(overlapped, false);
  await pass.close();
});

test("close() waits for the pass under way and takes no more requests", async () => {
  const hold = gate();
  const events: string[] = [];
  const pass = new SerialPass(async () => {
    events.push("start");
    await hold.opened;
    events.push("end");
  }, unexpected);
  pass.request();
  await nextTurn();
  pass.request();
  const closed = pass.close().then(() => events.push("closed"));
  assert.equal(pass.closed, true);
  hold.open();
  await closed;
  pass.request();
  await nextTurn();
  await nextTurn();
  assert.deepEqual(events, ["start", "end", "closed"]);
});

test("a pass that throws is reported, and the next request runs it again", async () => {
  const errors: unknown[] = [];
  let runs = 0;
  const pass = new SerialPass(
    async () => {
      runs += 1;
      if (runs === 1) throw new Error("boom");
    },
    (error) => errors.push(error),
  );
  pass.request();
  await nextTurn();
  await nextTurn();
  pass.request();
  await nextTurn();
  await nextTurn();
  assert.equal(runs, 2);
  assert.equal(errors.length, 1);
  await pass.close();
});
