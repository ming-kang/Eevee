import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, type Tx } from "@earendil-works/pi-durable";
import type { Report, Ticket, TicketId } from "../../domain/index.ts";
import { Board, ProposalDoc, ReportLog, TicketDoc } from "../docs.ts";
import { allocateTicketId, saveTicket } from "../orchestration/board.ts";
import {
  type DreamDraft,
  type DreamingPort,
  DreamLog,
  type DreamPolicy,
  dreamIfDue,
} from "./dreaming.ts";
import { addProposal } from "./proposals.ts";

const context = BACKGROUND_CONTEXT;

const POLICY: DreamPolicy = {
  idleMs: 100,
  minGapMs: 1000,
  afterTickets: 2,
  afterLessons: 2,
};

async function openHarness() {
  return Harness.open(
    new MemoryStorage(),
    { models: () => createModels(), registry: createRegistry() },
    context,
  );
}

function host(harness: Harness) {
  return { snapshot: harness.snapshot.bind(harness), commit: harness.commit.bind(harness) };
}

/** One ticket on the board; `closedAt` set marks it done. */
async function saveTicket_(tx: Tx, draft: Partial<Ticket> = {}): Promise<Ticket> {
  const id = await allocateTicketId(tx);
  const ticket = {
    id,
    role: "worker",
    title: `work ${id}`,
    goal: "goal",
    inputs: [],
    acceptance: [],
    deliverTo: [],
    conversationId: 0,
    status: "open",
    createdAt: 1,
    ...draft,
  } as unknown as Ticket;
  await saveTicket(tx, ticket);
  return ticket;
}

function close(harness: Harness, id: TicketId, closedAt: number) {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(TicketDoc, id, null);
    doc.status = "done";
    doc.closedAt = closedAt;
  }, context);
}

/** A port whose policy and idleness the test sets, that records the drafts it was asked to open. */
function port(overrides: Partial<DreamingPort> = {}) {
  const drafts: DreamDraft[] = [];
  const port: DreamingPort = {
    policy: () => POLICY,
    idleSince: async () => 0,
    contextOf: async () => ({ entries: [] }),
    open: async (tx, draft) => {
      drafts.push(draft);
      const ticket = await saveTicket_(tx, { role: "dreamer", title: draft.title });
      return ticket.id;
    },
    ...overrides,
  };
  return { port, drafts };
}

test("opens nothing while Dreaming is off", async () => {
  const harness = await openHarness();
  try {
    const { port: p, drafts } = port({ policy: () => undefined });
    await harness.commit(async (tx) => {
      await saveTicket_(tx, { status: "done", closedAt: 10 });
      await saveTicket_(tx, { status: "done", closedAt: 11 });
    }, context);
    assert.equal(await dreamIfDue(host(harness), p, 10_000, context), undefined);
    assert.equal(drafts.length, 0);
  } finally {
    await harness.close(context);
  }
});

test("a pending dreaming proposal gates dreaming, but a Router proposal or a decision does not", async (t) => {
  const harness = await openHarness();
  t.after(() => harness.close(context));
  await harness.commit(async (tx) => {
    await saveTicket_(tx, { status: "done", closedAt: 10 });
    await saveTicket_(tx, { status: "done", closedAt: 11 });
    await addProposal(tx, {
      scope: "global",
      source: { kind: "dreaming", ticketId: "t9" },
      conversationId: 42,
      summary: "Pending advice",
      actions: [],
      createdAt: 1,
    });
  }, context);
  const { port: p, drafts } = port();
  assert.equal(await dreamIfDue(host(harness), p, 10000, context), undefined);
  assert.equal(drafts.length, 0);
  await harness.commit(async (tx) => {
    (await tx.doc(ProposalDoc, "m1", null)).status = "rejected";
    (await tx.doc(Board)).openProposals = [];
    await addProposal(tx, {
      scope: "project",
      source: { kind: "router" },
      conversationId: 0,
      summary: "Router advice",
      actions: [],
      createdAt: 2,
    });
  }, context);
  assert.equal(await dreamIfDue(host(harness), p, 10000, context), "t3");
});

test("opens nothing while the project is busy, however much piled up", async () => {
  const harness = await openHarness();
  try {
    const { port: p, drafts } = port({ idleSince: async () => undefined });
    await harness.commit(async (tx) => {
      await saveTicket_(tx, { status: "done", closedAt: 10 });
      await saveTicket_(tx, { status: "done", closedAt: 11 });
    }, context);
    assert.equal(await dreamIfDue(host(harness), p, 10_000, context), undefined);
    assert.equal(drafts.length, 0);
  } finally {
    await harness.close(context);
  }
});

test("opens nothing below the material thresholds, and nothing while the idle time has not passed", async () => {
  const harness = await openHarness();
  try {
    await harness.commit(async (tx) => {
      await saveTicket_(tx, { status: "done", closedAt: 10 });
    }, context);
    const { port: p, drafts } = port();
    assert.equal(await dreamIfDue(host(harness), p, 10_000, context), undefined);
    assert.equal(drafts.length, 0);
    // Enough tickets now, but the project went idle only moments ago.
    await harness.commit(async (tx) => {
      await saveTicket_(tx, { status: "done", closedAt: 11 });
    }, context);
    const busy = port({ idleSince: async () => 10_000 });
    assert.equal(await dreamIfDue(host(harness), busy.port, 10_050, context), undefined);
    assert.equal(busy.drafts.length, 0);
  } finally {
    await harness.close(context);
  }
});

test("opens one dreamer ticket once idle with enough closed tickets, and not again while it is open", async () => {
  const harness = await openHarness();
  try {
    await harness.commit(async (tx) => {
      await saveTicket_(tx, { status: "done", closedAt: 10, closeNote: "shipped" });
      await saveTicket_(tx, { status: "done", closedAt: 11 });
    }, context);
    const { port: p, drafts } = port();
    const id = await dreamIfDue(host(harness), p, 10_000, context);
    assert.equal(id, "t3");
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.title, "Tidy up the memory store");
    assert.ok(drafts[0]?.inputs.some((input) => input.includes("report://t1")));

    const log = await harness.snapshot(DreamLog, context);
    assert.equal(log?.lastAt, 10_000);
    assert.equal(log?.ticket, "t3");

    // The open dreamer ticket blocks the next dreaming, even past the gap.
    assert.equal(await dreamIfDue(host(harness), p, 11_001, context), undefined);
    assert.equal(drafts.length, 1);
  } finally {
    await harness.close(context);
  }
});

test("lessons in reports alone make it due", async () => {
  const harness = await openHarness();
  try {
    const ticket = await harness.commit(async (tx) => {
      const ticket = await saveTicket_(tx, { status: "done", closedAt: 10 });
      const report = {
        ticketId: ticket.id,
        seq: 1,
        status: "ready",
        summary: "done",
        artifacts: [],
        lessons: ["always check the flag", "never mock the clock"],
        handled: true,
        reminded: false,
        at: 10,
      } as Report;
      (await tx.doc(ReportLog, ticket.id, null)).reports.push(report);
      return ticket;
    }, context);
    assert.ok(ticket);
    const { port: p, drafts } = port();
    const id = await dreamIfDue(host(harness), p, 10_000, context);
    assert.equal(id, "t2");
    assert.equal(drafts.length, 1);
  } finally {
    await harness.close(context);
  }
});

test("keeps minGapMs between two dreamings once the earlier one closed", async () => {
  const harness = await openHarness();
  try {
    // An earlier dreaming ended at 10_000; its ticket is closed.
    const first = await harness.commit(async (tx) => {
      const ticket = await saveTicket_(tx, { role: "dreamer" });
      return ticket;
    }, context);
    await close(harness, first.id, 9_000);
    await harness.commit(async (tx) => {
      const log = await tx.doc(DreamLog);
      log.lastAt = 10_000;
      log.ticket = first.id;
    }, context);
    await harness.commit(async (tx) => {
      await saveTicket_(tx, { status: "done", closedAt: 10_100 });
      await saveTicket_(tx, { status: "done", closedAt: 10_200 });
    }, context);

    const { port: p, drafts } = port();
    assert.equal(await dreamIfDue(host(harness), p, 10_900, context), undefined);
    assert.equal(drafts.length, 0);
    assert.equal(await dreamIfDue(host(harness), p, 11_000, context), "t4");
    assert.equal(drafts.length, 1);
  } finally {
    await harness.close(context);
  }
});
