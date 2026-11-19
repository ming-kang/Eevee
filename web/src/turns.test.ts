import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptDisplayItem } from "./transcript-map.ts";
import { finalAssistantKeys, foldTurns } from "./turns.ts";

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

test("a finished turn folds its work, keeps its reply", () => {
  const out = foldTurns([user("u1", 1000), tools("t1", 2), assistant("a1", 4000)], false);
  assert.deepEqual(kinds(out), ["user", "worked", "assistant"]);
  const worked = out[1];
  assert.equal(worked?.kind, "worked");
  if (worked?.kind !== "worked") return;
  assert.equal(worked.ms, 3000);
  assert.deepEqual(worked.counts, { tools: 2, commands: 0, files: 0, dispatched: 0 });
  assert.deepEqual(kinds(worked.items), ["tools"]);
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

test("streaming replies and running edits keep the turn open", () => {
  const out = foldTurns([user("u1"), edit("e1", "run"), assistant("a1", undefined, true)], false);
  assert.deepEqual(kinds(out), ["user", "edit", "assistant"]);
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

test("a mid-turn message folds with the work; only the final reply stays", () => {
  const out = foldTurns(
    [user("u1", 1000), tools("t1"), assistant("a1", 2000), tools("t2"), assistant("a2", 5000)],
    false,
  );
  assert.deepEqual(kinds(out), ["user", "worked", "assistant"]);
  const worked = out[1];
  if (worked?.kind !== "worked") throw new Error("no worked item");
  assert.deepEqual(kinds(worked.items), ["tools", "assistant", "tools"]);
  assert.equal(worked.ms, 4000);
});

test("a leading turn after an opening folds with no duration", () => {
  const out = foldTurns(
    [{ kind: "opening", key: "o1", text: "ticket" }, tools("t1"), assistant("a1", 9000)],
    false,
  );
  assert.deepEqual(kinds(out), ["opening", "worked", "assistant"]);
  const worked = out[1];
  if (worked?.kind !== "worked") throw new Error("no worked item");
  assert.equal(worked.ms, undefined);
});

test("duration uses the boundary's time when it has one", () => {
  const out = foldTurns(
    [{ kind: "reset", key: "r1", at: 500, summary: "s" }, tools("t1"), assistant("a1", 1500)],
    false,
  );
  const worked = out[1];
  if (worked?.kind !== "worked") throw new Error("no worked item");
  assert.equal(worked.ms, 1000);
});

test("counts cover steps, commands, files and dispatched tickets", () => {
  const out = foldTurns(
    [
      user("u1"),
      tools("t1", 3),
      bash("b1"),
      dispatch("d1", 4),
      edit("e1"),
      edit("e2"),
      assistant("a1"),
    ],
    false,
  );
  const worked = out[1];
  if (worked?.kind !== "worked") throw new Error("no worked item");
  assert.deepEqual(worked.counts, { tools: 3, commands: 1, files: 2, dispatched: 4 });
  assert.deepEqual(kinds(out), ["user", "worked", "assistant"]);
});

test("a dispatch trailing the reply is part of the visible tail", () => {
  const out = foldTurns([user("u1"), tools("t1"), assistant("a1"), dispatch("d1")], false);
  assert.deepEqual(kinds(out), ["user", "worked", "assistant", "dispatch"]);
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
  assert.deepEqual(kinds(out), ["user", "worked", "assistant", "qa", "worked", "assistant"]);
  const second = out[4];
  if (second?.kind !== "worked") throw new Error("no worked item");
  assert.equal(second.ms, 700);
});

test("untimed turns fold without a duration", () => {
  const out = foldTurns([user("u1"), tools("t1"), assistant("a1")], false);
  const worked = out[1];
  if (worked?.kind !== "worked") throw new Error("no worked item");
  assert.equal(worked.ms, undefined);
});

test("finalAssistantKeys marks each turn's last assistant", () => {
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
    ],
    false,
  );
  assert.deepEqual(kinds(folded), [
    "user",
    "worked",
    "assistant",
    "assistant",
    "user",
    "worked",
    "assistant",
    "dispatch",
  ]);
  assert.deepEqual([...finalAssistantKeys(folded)].sort(), ["a2", "a3"]);
});
