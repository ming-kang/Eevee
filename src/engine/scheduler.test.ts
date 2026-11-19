import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  Harness,
  LiveDoc,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { TicketDoc } from "../contracts/docs.ts";
import type { Ticket, TicketId } from "../contracts/index.ts";
import { allocateTicketId, saveTicket } from "../extensions/orchestration/board.ts";
import { conversationOf, WorkerQueue } from "../extensions/orchestration/index.ts";
import { DEFAULT_SETTINGS } from "../shared/settings.ts";
import { Scheduler, type SchedulerDeps } from "./scheduler.ts";

const context = BACKGROUND_CONTEXT;

async function openHarness() {
  return Harness.open(
    new MemoryStorage(),
    { models: () => createModels(), registry: createRegistry() },
    context,
  );
}

async function openTicket(harness: Harness, title = "scan") {
  return harness.commit(async (tx) => {
    const id = await allocateTicketId(tx);
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const opened = {
      id,
      title,
      goal: "scan",
      acceptance: [],
      role: "worker",
      status: "open",
      conversationId: conversation.id,
      createdAt: 1,
    } as unknown as Ticket;
    await saveTicket(tx, opened);
    return opened;
  }, context);
}

function settleTicket(harness: Harness, id: TicketId) {
  return harness.commit(async (tx) => {
    (await tx.doc(TicketDoc, id, null)).status = "done";
  }, context);
}

/**
 * The Scheduler's deps over a real Session. `root` stands in for the Router's conversation: its agent names no
 * model, so the upkeep's handoff check is always under the threshold.
 */
function deps(
  harness: SchedulerDeps["harness"],
  jobs: SchedulerDeps["jobs"],
  overrides: Partial<SchedulerDeps> = {},
): SchedulerDeps {
  return {
    harness,
    root: {
      agent: async () => ({ model: undefined }),
      commit: harness.commit.bind(harness),
    } as unknown as Conversation,
    jobs,
    settings: () => DEFAULT_SETTINGS,
    models: () => createModels(),
    context,
    label: "p1",
    ...overrides,
  };
}

/** The observer a ProjectHost attaches; tests drive `hear()` the same way. */
function hear(harness: Harness, scheduler: Scheduler) {
  return harness.observeCommits({ advance: (pub) => scheduler.hear(pub), end: () => {} });
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await check()); i += 1) await sleep(5);
  assert.ok(await check(), "timed out");
}

test("close() waits for the stop under way, so the Session closes only after it is recorded", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const harness = await openHarness();
  const ticket = await openTicket(harness);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const stopped: TicketId[] = [];
  const scheduler = await Scheduler.start(
    deps(
      {
        snapshot: harness.snapshot.bind(harness),
        conversation: async (...args) => {
          events.push("abort");
          await held;
          return harness.conversation(...args);
        },
        commit: async (change, ctx) => {
          const result = await harness.commit(change, ctx);
          events.push("recorded");
          return result;
        },
      } as SchedulerDeps["harness"],
      { stop: (id) => stopped.push(id) },
    ),
  );
  hear(harness, scheduler);
  await settleTicket(harness, ticket.id);
  await until(() => events.includes("abort"));

  const closing = scheduler.close().then(async () => {
    await harness.close(context);
    events.push("closed");
  });
  await sleep(20);
  assert.deepEqual(events, ["abort"]);
  release();
  await closing;
  assert.deepEqual(events, ["abort", "recorded", "closed"]);
  assert.deepEqual(stopped, [ticket.id]);
  assert.equal(errors.mock.callCount(), 0);
});

test("a ticket settled while the Scheduler runs is stopped: jobs stop and stoppedAt is recorded", async () => {
  const harness = await openHarness();
  const ticket = await openTicket(harness);
  const stopped: TicketId[] = [];
  const scheduler = await Scheduler.start(deps(harness, { stop: (id) => stopped.push(id) }));
  hear(harness, scheduler);
  try {
    await settleTicket(harness, ticket.id);
    await until(() => stopped.length === 1);
    assert.deepEqual(stopped, [ticket.id]);
    await until(
      async () => (await harness.snapshot(TicketDoc, ticket.id, context))?.stoppedAt !== undefined,
    );
  } finally {
    await scheduler.close();
    await harness.close(context);
  }
});

test("a ticket whose stop failed is kept and stopped by a later pass", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const harness = await openHarness();
  const ticket = await openTicket(harness);
  let failures = 1;
  const scheduler = await Scheduler.start(
    deps(
      {
        snapshot: harness.snapshot.bind(harness),
        commit: harness.commit.bind(harness),
        conversation: async (...args) => {
          if (failures-- > 0) throw new Error("not now");
          return harness.conversation(...args);
        },
      } as SchedulerDeps["harness"],
      { stop: () => {} },
    ),
  );
  hear(harness, scheduler);
  try {
    await settleTicket(harness, ticket.id);
    await until(() => errors.mock.callCount() === 1);
    assert.equal((await harness.snapshot(TicketDoc, ticket.id, context))?.stoppedAt, undefined);

    scheduler.request();
    await until(
      async () => (await harness.snapshot(TicketDoc, ticket.id, context))?.stoppedAt !== undefined,
    );
  } finally {
    await scheduler.close();
    await harness.close(context);
  }
});

test("on start it stops the tickets an earlier process settled but never stopped", async () => {
  const harness = await openHarness();
  const ticket = await openTicket(harness);
  await settleTicket(harness, ticket.id);
  const stopped: TicketId[] = [];
  const scheduler = await Scheduler.start(deps(harness, { stop: (id) => stopped.push(id) }));
  try {
    await until(() => stopped.length === 1);
    await until(
      async () => (await harness.snapshot(TicketDoc, ticket.id, context))?.stoppedAt !== undefined,
    );
  } finally {
    await scheduler.close();
    await harness.close(context);
  }
});

test("a queued start beyond the slot limit begins as soon as a run ends, driven by commits alone", async () => {
  const harness = await openHarness();
  const running = await openTicket(harness, "running");
  const queued = await openTicket(harness, "queued");
  // One busy ticket fills the only slot; the other's start waits in the queue.
  await harness.commit(async (tx) => {
    (await tx.doc(LiveDoc, conversationOf(running))).run = {
      taskId: "task-1",
      inputs: [],
      turns: 0,
    } as never;
    (await tx.doc(WorkerQueue)).pending.push({
      ticketId: queued.id,
      requestId: `opening:${queued.id}`,
    });
  }, context);

  const started: string[] = [];
  const scheduler = await Scheduler.start(
    deps(
      {
        snapshot: harness.snapshot.bind(harness),
        commit: harness.commit.bind(harness),
        conversation: async (id, ctx) => {
          if (id === conversationOf(queued)) {
            return {
              submit: async (_tx: unknown, draft: { requestId?: string }) => {
                started.push(draft.requestId ?? "");
                return "submission";
              },
            } as unknown as Conversation;
          }
          return harness.conversation(id, ctx);
        },
      } as SchedulerDeps["harness"],
      { stop: () => {} },
      {
        settings: () => ({ ...DEFAULT_SETTINGS, maxActiveWorkers: 1 }),
        upkeepMs: 60 * 60_000,
      },
    ),
  );
  hear(harness, scheduler);
  try {
    await sleep(50);
    assert.deepEqual(started, []);
    assert.equal(
      (await harness.snapshot(WorkerQueue, context))?.pending.length,
      1,
      "the queued start stays while the slot is taken",
    );

    // The run ends; the commit alone schedules the pass that frees the slot.
    await harness.commit(async (tx) => {
      delete (await tx.doc(LiveDoc, conversationOf(running))).run;
    }, context);
    await until(() => started.length === 1);
    assert.deepEqual(started, [`opening:${queued.id}`]);
    await until(async () => (await harness.snapshot(WorkerQueue, context))?.pending.length === 0);
  } finally {
    await scheduler.close();
    await harness.close(context);
  }
});
