import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAnswer,
  initialDraft,
  initialOtherFlags,
  isComplete,
  splitFormattedAnswer,
} from "./questions.ts";

const single = {
  items: [{ text: "Which database?", options: ["SQLite", "Postgres"], recommended: "SQLite" }],
};
const double = {
  items: [
    { text: "Which language?", options: ["TS", "Go"] },
    { text: "Where to deploy?", options: [], recommended: "Local" },
  ],
};

test("a recommended option is preselected", () => {
  assert.deepEqual(initialDraft(single), ["SQLite"]);
  assert.deepEqual(initialDraft(double), ["", "Local"]);
});

test("the initial 'other' state opens on an open question or a non-preset option", () => {
  assert.deepEqual(initialOtherFlags(single, ["SQLite"]), [false]);
  assert.deepEqual(initialOtherFlags(single, ["DuckDB"]), [true]);
  assert.deepEqual(initialOtherFlags(double, ["TS", "Local"]), [false, true]);
});

test("it is complete only when every question has an answer", () => {
  assert.equal(isComplete(initialDraft(double)), false);
  assert.equal(isComplete(["TS", "Local"]), true);
});

test("a single question answers directly; several are numbered one by one", () => {
  assert.equal(formatAnswer(single, [" Postgres "]), "Postgres");
  assert.equal(
    formatAnswer(double, ["TS", "Local"]),
    "1. Which language?\n   TS\n2. Where to deploy?\n   Local",
  );
});

test("a formatted multi-answer splits back into its per-item parts", () => {
  const items = [{ text: "Which language?" }, { text: "Where to deploy?" }];
  assert.deepEqual(
    splitFormattedAnswer(items, "1. Which language?\n   TS\n2. Where to deploy?\n   Local"),
    ["TS", "Local"],
  );
  assert.equal(splitFormattedAnswer(items, "TS and local"), undefined);
  assert.equal(splitFormattedAnswer(items, "1. Which language?\n   TS\n3. Nope\n   x"), undefined);
  assert.equal(splitFormattedAnswer([{ text: "one" }], "yes"), undefined);
});
