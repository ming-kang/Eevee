import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveState } from "@earendil-works/pi-durable";
import { summarizeRun } from "./failure.ts";

test("summarizeRun 忽略主动打断、交接重置和无事可答，只报告真实失败", () => {
  assert.deepEqual(summarizeRun(undefined), { running: false });
  assert.deepEqual(summarizeRun({ run: { taskId: 1 as never, inputs: [], turns: 1 } }), {
    running: true,
  });
  for (const reason of ["aborted", "reset", "nothing_to_answer"] as const) {
    const live: LiveState = { runFailure: { taskId: 2 as never, inputs: [], reason } };
    assert.deepEqual(summarizeRun(live), { running: false }, reason);
  }
  const failed: LiveState = {
    runFailure: { taskId: 3 as never, inputs: [], reason: "model_error", detail: "timeout" },
  };
  assert.deepEqual(summarizeRun(failed), { running: false, failure: "模型调用失败：timeout" });
});
