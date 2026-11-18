import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MemoryConflict, MemoryRepo } from "./repo.ts";

let dir: string;
let repo: MemoryRepo;
const log = () =>
  execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim().split("\n");

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "eevee-memory-"));
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "eevee-test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "eevee@test.invalid";
  repo = new MemoryRepo(dir);
  await repo.ensure("# Memory\n");
});

after(() => rm(dir, { recursive: true, force: true }));

test("this round's changes become one commit, and a user's own edit is committed separately", async () => {
  await repo.create("sim.md", "- simulation step 0.1\n", "0");
  await repo.edit("MEMORY.md", "# Memory\n", "# Memory\n- [[sim]] simulation lessons\n", "0");
  await writeFile(join(dir, "notes.md"), "written by the user\n");
  await repo.commitRound("0", "memory");
  assert.deepEqual(log().slice(0, 2), ["memory: edit MEMORY.md; create sim.md", "user edit"]);
});

test("each conversation commits its own changes, and an unfinished round stays in the workspace", async () => {
  await repo.create("dream.md", "- tidied lessons\n", "7");
  await repo.create("router.md", "- user preferences\n", "0");
  await repo.commitRound("7", "dreaming t2");
  assert.equal(log()[0], "dreaming t2: create dream.md");
  await repo.commitRound("0", "memory");
  assert.equal(log()[0], "memory: create router.md");
});

test("committing does nothing when there are no changes", async () => {
  const before = log().length;
  await repo.commitRound("0", "memory");
  assert.equal(log().length, before);
});

test("an edit is refused when the original text does not match, and the latest content comes back", async () => {
  await assert.rejects(
    repo.edit("sim.md", "text that is not there", "x", "0"),
    (error: unknown) => {
      assert.ok(error instanceof MemoryConflict);
      assert.match(error.current, /simulation step/);
      return true;
    },
  );
});

test("a path cannot escape the memory store", async () => {
  await assert.rejects(repo.create("../escape.md", "x", "0"), /must stay inside/);
});

test("history lists by commit, and reverting one creates the reverse commit", async () => {
  await repo.create("revert-me.md", "temporary\n", "r");
  await repo.commitRound("r", "memory");
  const [latest] = await repo.history(1);
  assert.equal(latest?.subject, "memory: create revert-me.md");
  assert.match(latest?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.match(await repo.diff(latest?.commit), /\+temporary/);

  await repo.revert(latest?.commit ?? "");
  assert.equal(await repo.read("revert-me.md"), undefined);
  assert.match(log()[0] ?? "", /^Revert "memory: create revert-me.md"/);
});

test("something that is not a commit, or cannot be reverted, gives a clear error and leaves the store alone", async () => {
  const before = log().length;
  await assert.rejects(repo.revert("--hard"), { problem: { code: "no_commit", commit: "--hard" } });
  await assert.rejects(repo.diff("HEAD~1"), { problem: { code: "no_commit", commit: "HEAD~1" } });
  await assert.rejects(repo.revert("deadbeef"), {
    problem: { code: "revert_failed", commit: "deadbeef" },
  });
  assert.equal(log().length, before);
});

test("listFiles lists every memory file, MEMORY.md first and .git excluded", async () => {
  await repo.create("topics/optics.md", "- optics lessons\n", "r2");
  const files = await repo.listFiles();
  assert.equal(files[0]?.path, "MEMORY.md");
  assert.equal(
    files.some((f) => f.path === "topics/optics.md" && f.size > 0),
    true,
  );
  assert.equal(
    files.some((f) => f.path.startsWith(".git")),
    false,
  );
  assert.equal(await repo.read("topics/optics.md"), "- optics lessons\n");
});
