import { defineTask } from "@earendil-works/pi-durable";

/** Retires persisted timers from before Dreaming moved to project upkeep. */
export const RETIRE_DREAM_TIMER = defineTask<null, { phase: "check" }, null>({
  name: "eevee.dream-timer",
  version: 1,
  initial: () => ({ phase: "check" }),
  phases: {
    check: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
