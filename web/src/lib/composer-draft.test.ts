import assert from "node:assert/strict";
import { test } from "node:test";
import { readDraft, saveDraft } from "./composer-draft.ts";

test("a composer remount restores its draft without leaking into another conversation", () => {
  saveDraft("r:alpha", "An unfinished message");
  assert.equal(readDraft("r:beta"), "");
  saveDraft("w:alpha:t1", "A worker message");
  assert.equal(readDraft("r:alpha"), "An unfinished message");
  assert.equal(readDraft("w:alpha:t1"), "A worker message");
  saveDraft("r:alpha", "");
  assert.equal(readDraft("r:alpha"), "");
  assert.equal(readDraft("w:alpha:t1"), "A worker message");
});

test("composers without a conversation key never share drafts", () => {
  saveDraft("", "Do not keep this");
  assert.equal(readDraft(""), "");
});
