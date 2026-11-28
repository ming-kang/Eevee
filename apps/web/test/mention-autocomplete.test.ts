import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardViewPayload } from "@eevee/protocol";
import { filterBoardMentions } from "../src/lib/mention-autocomplete.ts";

test("filterBoardMentions filters active workers and tickets respecting scope", () => {
  const board: BoardViewPayload = {
    workers: [
      {
        id: "w1",
        name: "backend",
        cwd: "/repo",
        conversationId: 2,
        createdAt: 1,
        status: "running",
        activeTaskCount: 0,
        tasks: [],
      },
      {
        id: "w2",
        name: "old",
        cwd: "/repo",
        conversationId: 3,
        createdAt: 2,
        closedAt: 3,
        status: "closed",
        activeTaskCount: 0,
        tasks: [],
      },
    ],
    tickets: [
      { id: "t1", workerId: "w1", title: "Fix login", status: "open", createdAt: 1 },
      { id: "t2", workerId: "w2", title: "Old fix", status: "done", createdAt: 2, closedAt: 3 },
    ],
    questions: [],
  };

  const emptyQuery = filterBoardMentions(board, "", "all");
  assert.deepEqual(
    emptyQuery.workers.map((w) => w.id),
    ["w1"],
  );
  assert.deepEqual(
    emptyQuery.tickets.map((t) => t.id),
    ["t1"],
  );

  const filesOnly = filterBoardMentions(board, "w1", "files");
  assert.equal(filesOnly.workers.length, 0);
  assert.equal(filesOnly.tickets.length, 0);
});
