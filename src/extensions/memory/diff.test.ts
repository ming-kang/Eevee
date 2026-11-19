import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff } from "./diff.ts";

test("parseDiff reads the multi-file hunks and line numbers of a patch", () => {
  const raw = [
    "diff --git a/MEMORY.md b/MEMORY.md",
    "index 111..222 100644",
    "--- a/MEMORY.md",
    "+++ b/MEMORY.md",
    "@@ -2,3 +2,3 @@ ## Core",
    " previous line",
    "-old content",
    "+new content",
    " next line",
    "diff --git a/notes.md b/notes.md",
    "new file mode 100644",
    "index 000..333",
    "--- /dev/null",
    "+++ b/notes.md",
    "@@ -0,0 +1,2 @@",
    "+first line",
    "+second line",
    "diff --git a/gone.md b/gone.md",
    "deleted file mode 100644",
    "index 333..000",
    "--- a/gone.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-only line",
  ].join("\n");

  const parsed = parseDiff(raw);
  assert.equal(parsed.length, 3);

  assert.equal(parsed[0]?.path, "MEMORY.md");
  assert.equal(parsed[0]?.status, "modified");
  assert.equal(parsed[0]?.added, 1);
  assert.equal(parsed[0]?.removed, 1);
  assert.equal(parsed[0]?.hunks[0]?.lines.length, 4);
  assert.deepEqual(parsed[0]?.hunks[0]?.lines[1], { kind: "del", old: 3, text: "old content" });
  assert.deepEqual(parsed[0]?.hunks[0]?.lines[2], { kind: "add", new: 3, text: "new content" });

  assert.equal(parsed[1]?.path, "notes.md");
  assert.equal(parsed[1]?.status, "added");
  assert.equal(parsed[1]?.added, 2);
  assert.equal(parsed[1]?.removed, 0);

  assert.equal(parsed[2]?.path, "gone.md");
  assert.equal(parsed[2]?.status, "deleted");
  assert.equal(parsed[2]?.removed, 1);
});
