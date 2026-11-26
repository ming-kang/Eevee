import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DraftStorage,
  draftStorageKey,
  restoreFailedDraft,
  restoreFailedDraftToStorage,
} from "../src/lib/composer-draft.ts";

function memoryStorage(initial: Record<string, string> = {}): DraftStorage & {
  readonly data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

test("restoreFailedDraft restores submitted text when textarea is empty and preserves newer input", () => {
  assert.equal(restoreFailedDraft("hello world", ""), "hello world");
  assert.equal(restoreFailedDraft("first message", "second draft"), "first message\nsecond draft");
});

test("restoreFailedDraftToStorage writes only when the target draft slot is empty", () => {
  const emptyStorage = memoryStorage();
  assert.equal(restoreFailedDraftToStorage(emptyStorage, "p1:router", "failed msg"), true);
  assert.equal(emptyStorage.data.get(draftStorageKey("p1:router")), "failed msg");

  const populatedStorage = memoryStorage({ [draftStorageKey("p1:router")]: "existing draft" });
  assert.equal(restoreFailedDraftToStorage(populatedStorage, "p1:router", "failed msg"), false);
  assert.equal(populatedStorage.data.get(draftStorageKey("p1:router")), "existing draft");
});
