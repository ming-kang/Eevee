import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardViewPayload, ProjectId, WorkerId } from "@eevee/protocol";
import { applyAllBoardsEvent } from "../src/lib/hooks.ts";

function makeBoard(workerName?: string): BoardViewPayload {
  return {
    workers: workerName
      ? [
          {
            id: "w1" as WorkerId,
            name: workerName,
            cwd: "/repo",
            conversationId: 1,
            createdAt: 100,
            status: "running",
            activeTaskCount: 0,
            tasks: [],
          },
        ]
      : [],
    tickets: [],
    questions: [],
  };
}

test("applyAllBoardsEvent handles snapshot, board, removed, and end without mutating prev", () => {
  const initialBoard = makeBoard("alpha");
  const prev: Record<string, BoardViewPayload> = {
    ["p1" as ProjectId]: initialBoard,
    ["p2" as ProjectId]: makeBoard("beta"),
  };

  const snapshotBoards = {
    ["p3" as ProjectId]: makeBoard("gamma"),
  };
  const afterSnapshot = applyAllBoardsEvent(prev, {
    type: "snapshot",
    boards: snapshotBoards,
  });
  assert.deepEqual(afterSnapshot, snapshotBoards);
  assert.notEqual(afterSnapshot, snapshotBoards);
  assert.deepEqual(Object.keys(prev), ["p1", "p2"]);

  const boardUpdate = makeBoard("delta");
  const afterBoard = applyAllBoardsEvent(afterSnapshot, {
    type: "board",
    projectId: "p4",
    board: boardUpdate,
  });
  assert.deepEqual(Object.keys(afterBoard), ["p3", "p4"]);
  assert.equal(afterBoard.p4, boardUpdate);
  assert.equal("p4" in afterSnapshot, false);

  const afterRemove = applyAllBoardsEvent(afterBoard, {
    type: "removed",
    projectId: "p3",
  });
  assert.deepEqual(Object.keys(afterRemove), ["p4"]);
  assert.equal("p3" in afterBoard, true);

  const afterMissingRemove = applyAllBoardsEvent(afterRemove, {
    type: "removed",
    projectId: "non-existent",
  });
  assert.equal(afterMissingRemove, afterRemove);

  const afterEnd = applyAllBoardsEvent(afterRemove, {
    type: "end",
    reason: "ended",
  });
  assert.equal(afterEnd, afterRemove);
});
