import assert from "node:assert/strict";
import test from "node:test";
import type { TicketView } from "@shared/api/contract.ts";
import { mentionQuery, rankTickets, splitTicketRefs } from "./mentions.ts";

const ticket = (id: string, title: string, status: "open" | "done" = "open"): TicketView => ({
  ticket: {
    id,
    title,
    status,
    goal: "",
    createdAt: 0,
    closedAt: status === "open" ? undefined : 1,
  } as TicketView["ticket"],
  stage: "working",
  reports: [],
  jobs: [],
});

test("mentionQuery finds @word at the caret", () => {
  assert.deepEqual(mentionQuery("@t4", 3), { start: 0, query: "t4" });
  assert.deepEqual(mentionQuery("hi @ti", 6), { start: 3, query: "ti" });
  assert.deepEqual(mentionQuery("a\n@x", 4), { start: 2, query: "x" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionQuery("see @draft-2", 12), { start: 4, query: "draft-2" });
});

test("mentionQuery rejects @ mid-word and mid-token carets", () => {
  assert.equal(mentionQuery("a@b", 3), undefined);
  assert.equal(mentionQuery("mail me@home", 12), undefined);
  assert.equal(mentionQuery("@t4x", 3), undefined); // caret inside the token
  assert.equal(mentionQuery("no at here", 10), undefined);
  assert.equal(mentionQuery("text", 0), undefined);
});

test("rankTickets: id prefix first, then titles; open before closed; max 8", () => {
  const tickets = [
    ticket("t1", "Template"),
    ticket("t9", "Closed but id prefix", "done"),
    ticket("t2", "Fix t9 graph"), // title match for "t9"
    ticket("t3", "Unrelated"),
  ];
  assert.deepEqual(
    rankTickets(tickets, "t9").map((v) => v.ticket.id),
    ["t9", "t2"],
  );
  assert.deepEqual(
    rankTickets(tickets, "t").map((v) => v.ticket.id),
    ["t1", "t2", "t3", "t9"],
  );
  const many = Array.from({ length: 12 }, (_, i) => ticket(`t${i + 1}`, `Ticket ${i + 1}`));
  assert.equal(rankTickets(many, "").length, 8);
});

test("splitTicketRefs chips only known ticket ids", () => {
  const ids = new Set(["t1", "t4"]);
  assert.deepEqual(splitTicketRefs("review t1 then t4.", ids), [
    { kind: "text", text: "review " },
    { kind: "ticket", ticketId: "t1" },
    { kind: "text", text: " then " },
    { kind: "ticket", ticketId: "t4" },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(splitTicketRefs("t9 is unknown", ids), [
    { kind: "text", text: "t9 is unknown" },
  ]);
  assert.deepEqual(splitTicketRefs("not a ref at1 all", ids), [
    { kind: "text", text: "not a ref at1 all" },
  ]);
  assert.deepEqual(splitTicketRefs("t1 and t12 both here", ids), [
    { kind: "ticket", ticketId: "t1" },
    { kind: "text", text: " and t12 both here" },
  ]);
});
