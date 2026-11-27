import assert from "node:assert/strict";
import { test } from "node:test";
import { runBackoffStream } from "../src/lib/hooks.ts";

test("runBackoffStream retries with backoff, resets on activity, and stops cleanly on stop() or abort", async () => {
  const controller = new AbortController();
  let attempts = 0;

  await runBackoffStream(
    { signal: controller.signal, initialDelayMs: 5, maxDelayMs: 20 },
    async ({ resetBackoff, stop }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      if (attempts === 2) {
        resetBackoff();
        return;
      }
      if (attempts === 3) {
        stop();
        return;
      }
    },
  );
  assert.equal(attempts, 3);

  const abortController = new AbortController();
  let abortedAttempts = 0;
  await runBackoffStream(
    { signal: abortController.signal, initialDelayMs: 5_000, maxDelayMs: 10_000 },
    async () => {
      abortedAttempts += 1;
      abortController.abort();
    },
  );
  assert.equal(abortedAttempts, 1);
});
