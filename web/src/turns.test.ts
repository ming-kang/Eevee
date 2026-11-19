import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptDisplayItem } from "./transcript-map.ts";
import { closedItems, finalAssistantKeys, foldTurns } from "./turns.ts";

const user = (key: string, at?: number): TranscriptDisplayItem => ({
  kind: "user",
  key,
  text: "do it",
  ...(at === undefined ? {} : { at }),
});

const assistant = (key: string, at?: number, streaming = false): TranscriptDisplayItem => ({
  kind: "assistant",
  key,
  text: "done",
  ...(at === undefined ? {} : { at }),
  ...(streaming ? { streaming: true } : {}),
});

const thinking = (key: string, streaming = false): TranscriptDisplayItem => ({
  kind: "thinking",
  key,
  text: "hmm",
  ...(streaming ? { streaming: true as const } : {}),
});

const tools = (key: string, n = 1, live = false): TranscriptDisplayItem => ({
  kind: "tools",
  key,
  live,
  steps: Array.from({ length: n }, (_, i) => ({
    id: `${key}:${i}`,
    tool: "read",
    label: "x",
    status: "ok",
  })),
});

const bash = (key: string, status: "run" | "exit" = "exit"): TranscriptDisplayItem => ({
  kind: "bash",
  key,
  command: "ls",
  status,
  output: "",
});

const edit = (key: string, status: "ok" | "err" | "run" = "ok"): TranscriptDisplayItem => ({
  kind: "edit",
  key,
  action: "edit",
  path: "a.ts",
  status,
  diff: [],
  added: 1,
  removed: 0,
});

const dispatch = (key: string, creates = 1): TranscriptDisplayItem => ({
  kind: "dispatch",
  key,
  live: false,
  actions: Array.from({ length: creates }, (_, i) => ({
    id: `${key}:${i}`,
    kind: "create",
    title: "T",
    status: "ok",
  })),
});

const kinds = (items: readonly TranscriptDisplayItem[]) => items.map((i) => i.kind);

const worked = (items: readonly TranscriptDisplayItem[]) => {
  const item = items.find((i) => i.kind === "worked");
  if (item?.kind !== "worked") throw new Error("no worked item");
  return item;
};

test("a finished turn folds its whole body; the closed view keeps the reply", () => {
  const out = foldTurns([user("u1", 1000), tools("t1", 2), assistant("a1", 4000)], false);
  assert.deepEqual(kinds(out), ["user", "worked"]);
  const group = worked(out);
  assert.equal(group.ms, 3000);
  assert.deepEqual(kinds(group.items), ["tools", "assistant"]);
  assert.deepEqual(kinds(closedItems(group)), ["assistant"]);
});

test("process → reply → process → reply folds once, and both replies stay visible", () => {
  const out = foldTurns(
    [user("u1", 1000), tools("t1"), assistant("a1", 2000), tools("t2"), assistant("a2", 5000)],
    false,
  );
  assert.deepEqual(kinds(out), ["user", "worked"]);
  const group = worked(out);
  assert.deepEqual(kinds(group.items), ["tools", "assistant", "tools", "assistant"]);
  assert.deepEqual(
    closedItems(group).map((i) => i.key),
    ["a1", "a2"],
  );
  assert.equal(group.ms, 4000);
});

test("a turn with nothing but replies, or replies and dispatches, never folds", () => {
  assert.deepEqual(kinds(foldTurns([user("u1"), assistant("a1"), assistant("a2")], false)), [
    "user",
    "assistant",
    "assistant",
  ]);
  assert.deepEqual(kinds(foldTurns([user("u1"), assistant("a1"), dispatch("d1")], false)), [
    "user",
    "assistant",
    "dispatch",
  ]);
});

test("the last turn stays expanded while the conversation runs", () => {
  const input = [user("u1", 1000), tools("t1"), assistant("a1", 4000)];
  assert.deepEqual(foldTurns(input, true), input);
});

test("a turn with a live line stays expanded", () => {
  const liveTools = tools("t1", 1, true);
  const out = foldTurns([user("u1", 1000), liveTools, assistant("a1", 4000)], false);
  assert.deepEqual(kinds(out), ["user", "tools", "assistant"]);
});

test("streaming replies, thinking and running edits keep the turn open", () => {
  const out = foldTurns(
    [user("u1"), edit("e1", "run"), thinking("th1", true), assistant("a1", undefined, true)],
    false,
  );
  assert.deepEqual(kinds(out), ["user", "edit", "thinking", "assistant"]);
});

test("tool-only turns never fold: no reply to leave visible", () => {
  const out = foldTurns([user("u1"), tools("t1"), bash("b1")], false);
  assert.deepEqual(kinds(out), ["user", "tools", "bash"]);
});

test("a turn ending in failure or idle stays expanded", () => {
  for (const end of [
    { kind: "failure", key: "f", reason: "x", text: "x" } as const,
    { kind: "idle", key: "i", text: "x" } as const,
  ]) {
    const out = foldTurns([user("u1"), tools("t1"), assistant("a1"), end], false);
    assert.deepEqual(kinds(out), ["user", "tools", "assistant", end.kind]);
  }
});

test("dispatch lines fold into the group and stay visible in the closed view", () => {
  const out = foldTurns([user("u1"), tools("t1"), assistant("a1"), dispatch("d1")], false);
  assert.deepEqual(kinds(out), ["user", "worked"]);
  const group = worked(out);
  assert.deepEqual(kinds(closedItems(group)), ["assistant", "dispatch"]);
});

test("a leading turn after an opening folds with no duration", () => {
  const out = foldTurns(
    [{ kind: "opening", key: "o1", text: "ticket" }, tools("t1"), assistant("a1", 9000)],
    false,
  );
  assert.deepEqual(kinds(out), ["opening", "worked"]);
  const group = worked(out);
  assert.equal(group.ms, undefined);
});

test("duration uses the boundary's time when it has one", () => {
  const out = foldTurns(
    [{ kind: "reset", key: "r1", at: 500, summary: "s" }, tools("t1"), assistant("a1", 1500)],
    false,
  );
  const group = worked(out);
  assert.equal(group.ms, 1000);
});

test("activity covers steps, commands, edits and dispatches-in-tools, not replies or dispatch lines", () => {
  const out = foldTurns(
    [
      user("u1"),
      tools("t1", 3),
      bash("b1"),
      dispatch("d1", 4),
      edit("e1"),
      edit("e2"),
      thinking("th1"),
      assistant("a1"),
    ],
    false,
  );
  const group = worked(out);
  assert.deepEqual(group.activity, [
    { kind: "read", count: 3 },
    { kind: "commands", count: 1 },
    { kind: "edit", count: 2 },
  ]);
  assert.deepEqual(kinds(out), ["user", "worked"]);
});

test("several turns fold independently; inbound lines re-open a turn", () => {
  const out = foldTurns(
    [
      user("u1", 0),
      tools("t1"),
      assistant("a1", 100),
      { kind: "qa", key: "q1", question: "q", answer: "a", at: 200 },
      tools("t2"),
      assistant("a2", 900),
    ],
    false,
  );
  assert.deepEqual(kinds(out), ["user", "worked", "qa", "worked"]);
  const second = out[3];
  if (second?.kind !== "worked") throw new Error("no worked item");
  assert.equal(second.ms, 700);
});

test("untimed turns fold without a duration", () => {
  const out = foldTurns([user("u1"), tools("t1"), assistant("a1")], false);
  const group = worked(out);
  assert.equal(group.ms, undefined);
});

test("finalAssistantKeys marks each turn's last assistant, inside folded groups too", () => {
  const folded = foldTurns(
    [
      user("u1"),
      tools("t1"),
      assistant("a1"),
      assistant("a2"),
      user("u2"),
      tools("t2"),
      assistant("a3"),
      dispatch("d1"),
      user("u3"),
      tools("t3"),
      assistant("a4"),
      tools("t4"),
      assistant("a5"),
    ],
    false,
  );
  assert.deepEqual(kinds(folded), ["user", "worked", "user", "worked", "user", "worked"]);
  assert.deepEqual([...finalAssistantKeys(folded)].sort(), ["a2", "a3", "a5"]);
});

test("finalAssistantKeys marks unfolded turns the same way", () => {
  const items = [
    user("u1"),
    assistant("a1"),
    assistant("a2"),
    user("u2"),
    tools("t1", 1, true),
    assistant("a3"),
  ];
  assert.deepEqual([...finalAssistantKeys(items)].sort(), ["a2", "a3"]);
});
