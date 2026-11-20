import assert from "node:assert/strict";
import { test } from "node:test";
import { previewFiles } from "./preview.ts";

test("preview diffs describe additions, deletions and modifications using FileDiffs line numbers", () => {
  const files = previewFiles(
    new Map([
      ["edit.md", "old\n"],
      ["delete.md", "remove\n"],
    ]),
    new Map([
      ["edit.md", "new\n"],
      ["delete.md", undefined],
      ["create.md", "added\n"],
      ["empty.md", ""],
    ]),
  );
  assert.deepEqual(
    files.map(({ path, status, added, removed }) => ({ path, status, added, removed })),
    [
      { path: "edit.md", status: "modified", added: 1, removed: 1 },
      { path: "delete.md", status: "deleted", added: 0, removed: 1 },
      { path: "create.md", status: "added", added: 1, removed: 0 },
      { path: "empty.md", status: "added", added: 0, removed: 0 },
    ],
  );
  assert.deepEqual(files[0]?.hunks[0]?.lines, [
    { kind: "del", old: 1, text: "old" },
    { kind: "add", new: 1, text: "new" },
  ]);
});

test("unchanged previews are empty and missing terminal newlines are not rendered as content", () => {
  assert.deepEqual(previewFiles(new Map(), new Map()), []);
  assert.deepEqual(previewFiles(new Map([["a", "same"]]), new Map([["a", "same"]])), []);
  const files = previewFiles(new Map([["a", "old"]]), new Map([["a", "new"]]));
  assert.deepEqual(
    files[0]?.hunks[0]?.lines.map((line) => line.text),
    ["old", "new"],
  );
});
