import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardViewPayload } from "@eevee/protocol";
import {
  applyMentionAutocomplete,
  extractMentionToken,
  filterBoardMentions,
} from "../src/lib/mention-autocomplete.ts";

test("extractMentionToken detects file/scoped mentions and ignores emails and code blocks", () => {
  assert.deepEqual(extractMentionToken("check @src/app", 14), {
    rawQuery: "src/app",
    query: "src/app",
    scope: "all",
    start: 6,
    end: 14,
  });

  assert.deepEqual(extractMentionToken("请看@files:index", 14), {
    rawQuery: "files:index",
    query: "index",
    scope: "files",
    start: 2,
    end: 14,
  });

  assert.equal(extractMentionToken("mail user@example.com", 21), undefined);
  assert.equal(extractMentionToken("inline `@src/app`", 16), undefined);
  assert.equal(extractMentionToken("```ts\n@src/app\n```", 14), undefined);
});

test("applyMentionAutocomplete quotes paths with spaces and appends trailing space", () => {
  const token = extractMentionToken("open @my", 8);
  assert.ok(token);
  assert.deepEqual(applyMentionAutocomplete("open @my", token, "docs/my file.md"), {
    nextText: 'open @"docs/my file.md" ',
    nextCursor: 24,
  });
  assert.deepEqual(applyMentionAutocomplete("open @my", token, "src/index.ts"), {
    nextText: "open @src/index.ts ",
    nextCursor: 19,
  });
});

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
