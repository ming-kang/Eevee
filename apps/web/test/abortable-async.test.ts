import assert from "node:assert/strict";
import { test } from "node:test";
import { createAbortableRunner } from "../src/lib/useAbortableAsync.ts";

test("createAbortableRunner aborts superseded runs, guards unmount, and supports StrictMode reactivation", async () => {
  const runner = createAbortableRunner();

  let firstAborted = false;
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const firstRun = runner.run(async (signal) => {
    signal.addEventListener("abort", () => {
      firstAborted = true;
    });
    await firstPending;
    return "stale";
  });

  const secondRun = runner.run(async (signal, isCurrent) => {
    assert.equal(signal.aborted, false);
    assert.equal(isCurrent(), true);
    return "fresh";
  });

  assert.equal(firstAborted, true);
  releaseFirst();
  assert.equal(await firstRun, undefined);
  assert.equal(await secondRun, "fresh");

  let disposedAborted = false;
  let rejectDisposed!: (err: Error) => void;
  const thirdPending = new Promise<string>((_, reject) => {
    rejectDisposed = reject;
  });
  const thirdRun = runner.run(async (signal) => {
    signal.addEventListener("abort", () => {
      disposedAborted = true;
    });
    return thirdPending;
  });

  runner.dispose();
  assert.equal(disposedAborted, true);
  rejectDisposed(new Error("aborted"));
  assert.equal(await thirdRun, undefined);
  assert.equal(await runner.run(async () => "ignored-while-disposed"), undefined);

  runner.activate();
  assert.equal(await runner.run(async () => "after-reactivate"), "after-reactivate");

  await assert.rejects(
    runner.run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
});
