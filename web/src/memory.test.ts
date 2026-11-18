import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommitAuthor, parseGitDiff } from "./memory.ts";

test("classifyCommitAuthor tells dreaming, user, eevee and router apart", () => {
  assert.equal(classifyCommitAuthor("dreaming t10: edit MEMORY.md"), "dreaming");
  assert.equal(classifyCommitAuthor("user edit"), "user");
  assert.equal(classifyCommitAuthor("memory: init"), "eevee");
  assert.equal(classifyCommitAuthor('Revert "memory: edit MEMORY.md"'), "eevee");
  assert.equal(classifyCommitAuthor("memory: create figures.md; edit MEMORY.md"), "router");
});

test("parseGitDiff reads the multi-file hunks and line numbers of git show --stat --patch", () => {
  const raw = [
    "commit a1b2c3d",
    "Author: eevee",
    "",
    "    memory: create notes.md; edit MEMORY.md",
    "",
    " MEMORY.md | 2 +-",
    " notes.md  | 2 ++",
    " 2 files changed, 3 insertions(+), 1 deletion(-)",
    "",
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
  ].join("\n");

  const parsed = parseGitDiff(raw);
  assert.equal(parsed.length, 2);

  assert.equal(parsed[0]?.file, "MEMORY.md");
  assert.equal(parsed[0]?.added, 1);
  assert.equal(parsed[0]?.removed, 1);
  assert.equal(parsed[0]?.hunks[0]?.lines.length, 4);
  assert.deepEqual(parsed[0]?.hunks[0]?.lines[1], { k: "del", o: 3, s: "old content" });
  assert.deepEqual(parsed[0]?.hunks[0]?.lines[2], { k: "add", n: 3, s: "new content" });

  assert.equal(parsed[1]?.file, "notes.md");
  assert.equal(parsed[1]?.newFile, true);
  assert.equal(parsed[1]?.added, 2);
  assert.equal(parsed[1]?.removed, 0);
});
