import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardViewPayload, ProjectId, ProjectSummary, WorkerId } from "@eevee/protocol";
import { buildOverviewItems, filterOverviewItems } from "../src/lib/overview.ts";

function makeProject(id: string, title: string): ProjectSummary {
  return {
    id: id as ProjectId,
    title,
    workspaces: ["/tmp/repo"],
    createdAt: 1,
    updatedAt: 1,
  };
}

test("buildOverviewItems uses question text directly as title and partitions lanes cleanly", () => {
  const projects = [makeProject("p1", "Alpha"), makeProject("p2", "Beta")];
  const boards: Record<string, BoardViewPayload> = {
    p1: {
      workers: [
        {
          id: "w1" as WorkerId,
          name: "Builder",
          cwd: "/tmp/repo",
          conversationId: 2,
          createdAt: 200,
          status: "running",
          activeTicketId: "t1",
          activeTaskCount: 2,
          tasks: [],
        },
        {
          id: "w2" as WorkerId,
          name: "QueuedWorker",
          cwd: "/tmp/repo",
          conversationId: 3,
          createdAt: 150,
          status: "queued",
          activeTaskCount: 0,
          tasks: [],
        },
      ],
      tickets: [
        {
          id: "t1",
          workerId: "w1" as WorkerId,
          title: "Refactor composer",
          status: "open",
          createdAt: 200,
        },
        {
          id: "t2",
          workerId: "w1" as WorkerId,
          title: "Ship icons",
          status: "done",
          note: "All tests pass",
          createdAt: 100,
          closedAt: 180,
        },
      ],
      questions: [
        {
          id: "q1",
          askedAt: 300,
          items: [{ question: "Deploy to production?" }],
        },
        {
          id: "q2",
          askedAt: 250,
          answeredAt: 260,
          items: [{ question: "Already answered" }],
        },
      ],
    },
  };

  const items = buildOverviewItems(projects, boards, "", "Pending question");
  assert.equal(items.length, 4);
  assert.equal(items[0]?.lane, "pending");
  assert.equal(items[0]?.title, "Deploy to production?");
  assert.equal(items[0]?.chip, "q1");

  const running = items.filter((item) => item.lane === "running");
  assert.equal(running.length, 2);
  assert.equal(running[0]?.title, "Refactor composer");
  assert.equal(running[0]?.note, "w1 · Builder");
  assert.equal(running[0]?.activeTaskCount, 2);
  assert.equal(running[1]?.queued, true);
  assert.equal(running[1]?.title, "QueuedWorker");

  const filtered = filterOverviewItems(items, "production");
  assert.equal(filtered.pending.length, 1);
  assert.equal(filtered.running.length, 0);
  assert.equal(filtered.done.length, 0);
});
