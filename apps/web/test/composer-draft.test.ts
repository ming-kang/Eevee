import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DraftStorage,
  draftStorageKey,
  legacyDraftStorageKey,
  parseDraftValue,
  readDraft,
  restoreFailedDraft,
  restoreFailedDraftToStorage,
  writeDraft,
} from "../src/lib/composer-draft.ts";
import type { MessageChip } from "../src/lib/composer-value.ts";

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
    removeItem(key) {
      data.delete(key);
    },
  };
}

const chip: MessageChip = {
  kind: "file",
  id: "file-1",
  label: "src/app.ts",
  ref: "src/app.ts",
  name: "app.ts",
  dir: "src",
};

test("readDraft falls back to a legacy plain-text draft", () => {
  const storage = memoryStorage({ [legacyDraftStorageKey("p1:router")]: "old draft" });
  assert.deepEqual(readDraft(storage, "p1:router"), ["old draft"]);
  assert.deepEqual(readDraft(memoryStorage(), "p1:router"), []);
});

test("writeDraft stores text and chips, replaces the legacy draft, and clears when empty", () => {
  const storage = memoryStorage({ [legacyDraftStorageKey("p1:router")]: "old draft" });
  writeDraft(storage, "p1:router", ["see ", chip]);
  assert.equal(storage.data.has(legacyDraftStorageKey("p1:router")), false);
  assert.deepEqual(readDraft(storage, "p1:router"), ["see ", chip]);

  writeDraft(storage, "p1:router", []);
  assert.equal(storage.data.size, 0);
});

test("parseDraftValue drops malformed segments and rejects non-arrays", () => {
  assert.equal(parseDraftValue("not json"), undefined);
  assert.equal(parseDraftValue('{"a":1}'), undefined);
  assert.deepEqual(
    parseDraftValue(JSON.stringify(["a", { kind: "file", id: "x" }, 3, "b", chip])),
    ["ab", chip],
  );
});

test("restoreFailedDraft restores the sent message and keeps newer input after it", () => {
  assert.deepEqual(restoreFailedDraft(["hello ", chip], []), ["hello ", chip]);
  assert.deepEqual(restoreFailedDraft(["first"], ["second"]), ["first\nsecond"]);
  assert.deepEqual(restoreFailedDraft([chip], ["next"]), [chip, "\nnext"]);
});

test("restoreFailedDraftToStorage writes only when the target draft slot is empty", () => {
  const emptyStorage = memoryStorage();
  assert.equal(restoreFailedDraftToStorage(emptyStorage, "p1:router", ["failed msg"]), true);
  assert.deepEqual(readDraft(emptyStorage, "p1:router"), ["failed msg"]);

  const populatedStorage = memoryStorage({ [draftStorageKey("p1:router")]: '["existing draft"]' });
  assert.equal(restoreFailedDraftToStorage(populatedStorage, "p1:router", ["failed msg"]), false);
  assert.deepEqual(readDraft(populatedStorage, "p1:router"), ["existing draft"]);

  const legacyStorage = memoryStorage({ [legacyDraftStorageKey("p1:router")]: "legacy draft" });
  assert.equal(restoreFailedDraftToStorage(legacyStorage, "p1:router", ["failed msg"]), false);
});
