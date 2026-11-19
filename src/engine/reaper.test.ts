import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { TicketDoc } from "../contracts/docs.ts";
import type { Ticket, TicketId } from "../contracts/index.ts";
import { allocateTicketId, saveTicket } from "../extensions/orchestration/board.ts";
import { Reaper, type ReaperDeps } from "./reaper.ts";

const context = BACKGROUND_CONTEXT;

async function setup() {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: () => createModels(), registry: createRegistry() },
    context,
  );
  const ticket = await harness.commit(async (tx) => {
    const id = await allocateTicketId(tx);
    const opened = {
      id,
      title: "scan",
      goal: "scan",
      acceptance: [],
      role: "worker",
      status: "open",
      conversationId: `c-${id}`,
      createdAt: 1,
    } as unknown as Ticket;
    await saveTicket(tx, opened);
    return opened;
  }, context);
  const settleTicket = () =>
    harness.commit(async (tx) => {
      (await tx.doc(TicketDoc, ticket.id, null)).status = "done";
    }, context);
  return { harness, ticket, settleTicket };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await check()); i += 1) await sleep(5);
  assert.ok(await check(), "timed out");
}

test("close() waits for the stop under way, so the Session closes only after it is recorded", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const { harness, ticket, settleTicket } = await setup();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const stopped: TicketId[] = [];
  const deps: ReaperDeps = {
    harness: {
      snapshot: harness.snapshot.bind(harness),
      observeCommits: harness.observeCommits.bind(harness),
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
    } as ReaperDeps["harness"],
    jobs: { stop: (id) => stopped.push(id) },
    context,
    label: "p1",
  };
  const reaper = new Reaper(deps);
  await reaper.start();
  await settleTicket();
  await until(() => events.includes("abort"));

  const closing = reaper.close().then(async () => {
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

test("a ticket whose stop failed is kept and stopped by a later pass", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const { harness, ticket, settleTicket } = await setup();
  let failures = 1;
  const reaper = new Reaper({
    harness: {
      snapshot: harness.snapshot.bind(harness),
      observeCommits: harness.observeCommits.bind(harness),
      commit: harness.commit.bind(harness),
      conversation: async (...args) => {
        if (failures-- > 0) throw new Error("not now");
        return harness.conversation(...args);
      },
    } as ReaperDeps["harness"],
    jobs: { stop: () => {} },
    context,
    label: "p1",
  });
  try {
    await reaper.start();
    await settleTicket();
    await until(() => errors.mock.callCount() === 1);
    assert.equal((await harness.snapshot(TicketDoc, ticket.id, context))?.stoppedAt, undefined);

    reaper.request();
    await until(
      async () => (await harness.snapshot(TicketDoc, ticket.id, context))?.stoppedAt !== undefined,
    );
  } finally {
    await reaper.close();
    await harness.close(context);
  }
});

test("on start it stops the tickets an earlier process settled but never stopped", async () => {
  const { harness, ticket, settleTicket } = await setup();
  await settleTicket();
  const stopped: TicketId[] = [];
  const reaper = new Reaper({
    harness,
    jobs: { stop: (id) => stopped.push(id) },
    context,
    label: "p1",
  });
  try {
    await reaper.start();
    await until(() => stopped.length === 1);
    await until(
      async () => (await harness.snapshot(TicketDoc, ticket.id, context))?.stoppedAt !== undefined,
    );
  } finally {
    await reaper.close();
    await harness.close(context);
  }
});
