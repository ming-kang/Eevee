import assert from "node:assert/strict";
import { test } from "node:test";
import { computed, shallowRef } from "vue";
import type { TicketStage } from "../../../src/domain/index.ts";
import type { TicketView } from "../../../src/protocol/contract.ts";
import { resolveTicketRef } from "./ticket-ref.ts";

function ticket(stage: TicketStage = "working"): TicketView {
  return {
    ticket: {
      id: "t4",
      role: "worker",
      title: "Check references",
      goal: "",
      inputs: [],
      acceptance: [],
      deliverTo: [],
      conversationId: 1,
      status: "open",
      createdAt: 1,
    },
    stage,
    reports: [],
    jobs: [],
  };
}

test("ticket refs resolve their live board stage, title and display ID", () => {
  const board = shallowRef([ticket()]);
  const reference = computed(() => resolveTicketRef("T4", board.value));
  assert.deepEqual(reference.value, {
    ticketId: "t4",
    label: "T4",
    stage: "working",
    tooltip: "Check references · Working",
  });
  for (const stage of ["answer", "review", "blocked", "jobs", "idle"] as const) {
    board.value = [ticket(stage)];
    assert.equal(reference.value.stage, stage);
  }
  const done = ticket();
  done.ticket.status = "done";
  board.value = [done];
  assert.equal(reference.value.stage, "done");
  done.ticket.status = "cancelled";
  assert.equal(resolveTicketRef("t4", [done]).stage, "cancelled");
});

test("ticket refs keep custom labels and tolerate empty, missing or not-yet-loaded boards", () => {
  assert.equal(resolveTicketRef("t4", [ticket()], "References").label, "References");
  assert.equal(resolveTicketRef("t4", [ticket()], "T4").label, "T4");
  for (const board of [undefined, [], [ticket()]]) {
    assert.deepEqual(resolveTicketRef("t9", board), {
      ticketId: "t9",
      label: "T9",
      stage: undefined,
      tooltip: "T9",
    });
  }
  assert.equal(resolveTicketRef("unknown", []).stage, undefined);
});
