import assert from "node:assert/strict";
import test from "node:test";
import { activeEntry, outlineEntries } from "./outline.ts";
import type { TranscriptDisplayItem } from "./transcript-map.ts";

const user = (key: string, text = "do it", at?: number): TranscriptDisplayItem => ({
  kind: "user",
  key,
  text,
  ...(at === undefined ? {} : { at }),
});

const qa = (key: string, answer: string, at?: number): TranscriptDisplayItem => ({
  kind: "qa",
  key,
  question: "which?",
  answer,
  ...(at === undefined ? {} : { at }),
});

const assistant = (key: string): TranscriptDisplayItem => ({
  kind: "assistant",
  key,
  text: "done",
});

test("one entry per user and qa item, other kinds skipped", () => {
  const items: TranscriptDisplayItem[] = [
    user("u1", "first", 10),
    assistant("a1"),
    { kind: "tools", key: "t", live: false, steps: [] },
    qa("q1", "ACS Photonics", 20),
    { kind: "event", key: "e", eventKind: "report", text: "reported" },
    user("u2", "second"),
  ];
  const entries = outlineEntries(items);
  assert.deepEqual(
    entries.map((e) => e.key),
    ["u1", "q1", "u2"],
  );
  assert.equal(entries[0]?.text, "first");
  assert.equal(entries[0]?.at, 10);
  assert.equal(entries[1]?.text, "ACS Photonics");
  assert.equal(entries[2]?.at, undefined);
});

test("entry text is the first line, trimmed, cut around 80 chars", () => {
  const long = `${"x".repeat(120)} more`;
  const entries = outlineEntries([
    user("u1", "  padded line  \nsecond line ignored"),
    user("u2", long),
  ]);
  assert.equal(entries[0]?.text, "padded line");
  assert.equal(entries[1]?.text.length, 80);
  assert.ok(entries[1]?.text.endsWith("…"));
});

test("qa entries take the answer shown in the bubble", () => {
  const entries = outlineEntries([qa("q1", "  Yes, all of them\nwith details")]);
  assert.equal(entries[0]?.text, "Yes, all of them");
});

test("each entry carries an excerpt of the last reply before the next entry", () => {
  const workedItem: TranscriptDisplayItem = {
    kind: "worked",
    key: "w1",
    items: [
      { kind: "tools", key: "t", live: false, steps: [] },
      { kind: "assistant", key: "a1", text: "first reply" },
      { kind: "assistant", key: "a2", text: "inside the fold,\nlast reply" },
    ],
    activity: [],
  };
  const items: TranscriptDisplayItem[] = [
    user("u1", "one"),
    assistant("a0"),
    workedItem,
    user("u2", "two"),
    assistant("a3"),
    user("u3", "three"),
  ];
  const entries = outlineEntries(items);
  assert.equal(entries[0]?.reply, "inside the fold, last reply");
  assert.equal(entries[1]?.reply, "done");
  assert.equal(entries[2]?.reply, undefined);
});

test("reply excerpts collapse whitespace and cut around 120 chars", () => {
  const items: TranscriptDisplayItem[] = [
    user("u1"),
    { kind: "assistant", key: "a", text: `  spaced\n\nout   words\n${"x".repeat(140)}` },
  ];
  const entry = outlineEntries(items)[0];
  assert.ok(entry?.reply?.endsWith("…"));
  assert.equal(entry?.reply?.length, 120);
});

test("activeEntry is the last entry at or above the line", () => {
  const tops = [100, 400, 900];
  assert.equal(activeEntry(tops, 0, 0), -1);
  assert.equal(activeEntry(tops, 50, 60), 0);
  assert.equal(activeEntry(tops, 300, 60), 0);
  assert.equal(activeEntry(tops, 350, 60), 1);
  assert.equal(activeEntry(tops, 500, 0), 1);
  assert.equal(activeEntry(tops, 5000, 120), 2);
  assert.equal(activeEntry([], 100, 0), -1);
});
