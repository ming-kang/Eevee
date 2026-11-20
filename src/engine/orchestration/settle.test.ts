import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { Ticket } from "../../domain/index.ts";
import { Board, QuestionDoc, TicketDoc } from "../docs.ts";
import { addQuestion, allocateTicketId, readTicket, saveTicket } from "./board.ts";
import { settle } from "./settle.ts";

const context = BACKGROUND_CONTEXT;

async function openHarness(): Promise<Harness> {
  return Harness.open(
    new MemoryStorage(),
    { models: () => createModels(), registry: createRegistry() },
    context,
  );
}

async function openTicket(harness: Harness): Promise<Ticket> {
  return harness.commit(async (tx) => {
    const id = await allocateTicketId(tx);
    const ticket = {
      id,
      title: "tidy",
      goal: "tidy up",
      acceptance: [],
      role: "worker",
      status: "open",
      conversationId: `c-${id}`,
      createdAt: 1,
    } as unknown as Ticket;
    await saveTicket(tx, ticket);
    return ticket;
  }, context);
}

test("settling a ticket withdraws a question asked after the caller last read the ticket", async () => {
  const harness = await openHarness();
  try {
    const opened = await openTicket(harness);
    // The caller decides to settle from what it read here; a question is asked before its commit lands.
    const seen = await readTicket(harness, opened.id, context);
    assert.ok(seen !== undefined);

    const question = await harness.commit(
      (tx) =>
        addQuestion(tx, {
          ticketId: seen.id,
          items: [{ text: "which", options: ["a", "b"] }],
          askedAt: 2,
        }),
      context,
    );
    await harness.commit(
      (tx) => settle(tx, seen.id, { status: "done", note: "tidied", at: 3 }),
      context,
    );

    assert.equal((await harness.snapshot(TicketDoc, seen.id, context))?.status, "done");
    assert.equal((await harness.snapshot(QuestionDoc, question.id, context))?.withdrawnAt, 3);
    assert.deepEqual((await harness.snapshot(Board, context))?.openQuestions, []);
  } finally {
    await harness.close(context);
  }
});

test("settling leaves the questions of other tickets and of nobody open, and refuses a closed ticket", async () => {
  const harness = await openHarness();
  try {
    const mine = await openTicket(harness);
    const other = await openTicket(harness);
    const ask = (ticketId: Ticket["id"] | undefined) =>
      harness.commit(
        (tx) =>
          addQuestion(tx, {
            ...(ticketId === undefined ? {} : { ticketId }),
            items: [{ text: "which", options: ["a", "b"] }],
            askedAt: 2,
          }),
        context,
      );
    await ask(mine.id);
    const theirs = await ask(other.id);
    const nobodys = await ask(undefined);

    const close = { status: "cancelled", note: "dropped", at: 3 } as const;
    await harness.commit((tx) => settle(tx, mine.id, close), context);
    assert.deepEqual((await harness.snapshot(Board, context))?.openQuestions, [
      theirs.id,
      nobodys.id,
    ]);
    await assert.rejects(
      harness.commit((tx) => settle(tx, mine.id, close), context),
      (error: unknown) =>
        (error as { problem?: { code?: string } }).problem?.code === "ticket_closed",
    );
  } finally {
    await harness.close(context);
  }
});

test("settling a ticket that does not exist fails its commit instead of inventing the ticket", async () => {
  const harness = await openHarness();
  try {
    const close = { status: "done", note: "x", at: 1 } as const;
    await assert.rejects(
      harness.commit((tx) => settle(tx, "t9" as Ticket["id"], close), context),
      /no eevee\.ticket document/,
    );
    assert.equal(await harness.snapshot(TicketDoc, "t9", context), undefined);
  } finally {
    await harness.close(context);
  }
});
