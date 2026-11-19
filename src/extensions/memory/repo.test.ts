import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MemoryConflict, MemoryRepo } from "./repo.ts";

let dir: string;
let repo: MemoryRepo;
const subjects = () =>
  execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "eevee-memory-"));
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "eevee-test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "eevee@test.invalid";
  repo = new MemoryRepo(dir);
  await repo.ensure("# Memory\n");
});

after(() => rm(dir, { recursive: true, force: true }));

test("a run's edits become one change, and a user's own edit becomes a separate user change", async () => {
  await repo.create("sim.md", "- simulation step 0.1\n", "0");
  await repo.edit("MEMORY.md", "# Memory\n", "# Memory\n- [[sim]] simulation lessons\n", "0");
  await writeFile(join(dir, "notes.md"), "written by the user\n");
  const change = await repo.commitRound("0", { kind: "router" });
  assert.ok(change);
  assert.equal(change.summary, "edit MEMORY.md; create sim.md");
  assert.deepEqual(change.source, { kind: "router" });
  const history = await repo.history();
  const latest = history[0];
  const manual = history[1];
  assert.equal(latest?.id, change.id);
  assert.equal(manual?.source.kind, "user");
  assert.equal(manual?.summary, "create notes.md");
  assert.deepEqual(
    manual?.files.map((f) => f.path),
    ["notes.md"],
  );
  assert.match(subjects()[1] ?? "", /create notes\.md/);
});

test("each conversation saves its own change with its source, and an unfinished round stays in the workspace", async () => {
  await repo.create("dream.md", "- tidied lessons\n", "7");
  await repo.create("router.md", "- user preferences\n", "0");
  const dreaming = await repo.commitRound("7", { kind: "dreaming", ticketId: "t2" });
  assert.deepEqual(dreaming?.source, { kind: "dreaming", ticketId: "t2" });
  assert.equal(dreaming?.summary, "create dream.md");
  const router = await repo.commitRound("0", { kind: "router", ticketId: "t3" });
  assert.deepEqual(router?.source, { kind: "router", ticketId: "t3" });
  assert.equal(router?.summary, "create router.md");
});

test("saving does nothing when there are no changes", async () => {
  const before = subjects().length;
  assert.equal(await repo.commitRound("0", { kind: "router" }), undefined);
  assert.equal(subjects().length, before);
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

test("history numbers changes from the first and reads their sources", async () => {
  const history = await repo.history(50);
  assert.equal(history[history.length - 1]?.id, 1);
  assert.deepEqual(history[history.length - 1]?.source, { kind: "system" });
  assert.equal(history[history.length - 1]?.summary, "init");
  assert.deepEqual(
    history.map((c) => c.id),
    history.map((_, i) => history.length - i),
  );
  assert.ok(history.some((c) => c.source.kind === "router"));
  assert.ok(history.some((c) => c.source.kind === "dreaming"));
  assert.ok(history.some((c) => c.source.kind === "user"));
});

test("a pending round's files are not saved as user edits when history is read mid-run", async () => {
  await repo.create("pending.md", "- mid-run note\n", "mid");
  await writeFile(join(dir, "manual.md"), "touched by hand\n");
  const during = await repo.history(5);
  const userChange = during.find(
    (c) => c.source.kind === "user" && c.summary.includes("manual.md"),
  );
  assert.ok(userChange);
  assert.equal(
    userChange.files.some((f) => f.path === "pending.md"),
    false,
  );
  const change = await repo.commitRound("mid", { kind: "router" });
  assert.equal(change?.summary, "create pending.md");
});

test("show gives the structured edits of a change, including non-ASCII file names", async () => {
  await repo.create("münchen.md", "grüße\n", "u");
  await repo.edit("sim.md", "- simulation step 0.1\n", "- simulation step 0.2\n", "u");
  await writeFile(join(dir, "to-delete.md"), "gone soon\n");
  await repo.commitRound("pre-del", { kind: "router" });
  await repo.edit("to-delete.md", "gone soon\n", "", "u");
  const { rm: rmFile } = await import("node:fs/promises");
  await rmFile(join(dir, "to-delete.md"));
  const change = await repo.commitRound("u", { kind: "router" });
  assert.ok(change);
  const detail = await repo.show(change.id);
  const added = detail.files.find((f) => f.path === "münchen.md");
  assert.equal(added?.status, "added");
  assert.equal(added?.added, 1);
  assert.deepEqual(added?.hunks[0]?.lines[0], { kind: "add", new: 1, text: "grüße" });
  const modified = detail.files.find((f) => f.path === "sim.md");
  assert.equal(modified?.status, "modified");
  assert.equal(modified?.added, 1);
  assert.equal(modified?.removed, 1);
  const deleted = detail.files.find((f) => f.path === "to-delete.md");
  assert.equal(deleted?.status, "deleted");
  assert.equal(deleted?.removed, 1);
});

test("show and undo reject unknown change numbers with no_change", async () => {
  await assert.rejects(repo.show(9999), { problem: { code: "no_change", change: 9999 } });
  await assert.rejects(repo.undo(9999, { kind: "user" }), {
    problem: { code: "no_change", change: 9999 },
  });
  await assert.rejects(repo.undo(1, { kind: "user" }), {
    problem: { code: "undo_failed", change: 1 },
  });
});

test("undo appends a new change and restores the earlier content", async () => {
  await repo.create("undo-me.md", "temporary\n", "r");
  const change = await repo.commitRound("r", { kind: "router" });
  assert.ok(change);
  assert.equal(await repo.read("undo-me.md"), "temporary\n");

  const undone = await repo.undo(change.id, { kind: "user" });
  assert.equal(await repo.read("undo-me.md"), undefined);
  assert.equal(undone.id, change.id + 1);
  assert.equal(undone.summary, `Undo change #${change.id}`);
  assert.deepEqual(undone.source, { kind: "user" });
  assert.equal((await repo.history(1))[0]?.id, undone.id);
});

test("a conflicting undo fails and leaves the store alone", async () => {
  await repo.create("conflict.md", "original\n", "c1");
  await repo.commitRound("c1", { kind: "router" });
  await repo.edit("conflict.md", "original\n", "changed\n", "c2");
  const edit = await repo.commitRound("c2", { kind: "router" });
  assert.ok(edit);
  await repo.edit("conflict.md", "changed\n", "changed again\n", "c3");
  await repo.commitRound("c3", { kind: "router" });

  const count = (await repo.history(50)).length;
  const content = await repo.read("conflict.md");
  await assert.rejects(repo.undo(edit.id, { kind: "user" }), {
    problem: { code: "undo_failed", change: edit.id },
  });
  assert.equal(await repo.read("conflict.md"), content);
  assert.equal((await repo.history(50)).length, count);
});

test("a failed undo keeps a pending round's unsaved edits", async () => {
  await repo.create("undo-a.md", "first\n", "r1");
  const change = await repo.commitRound("r1", { kind: "router" });
  assert.ok(change);
  await repo.edit("undo-a.md", "first\n", "second (still being written)\n", "rX");

  await assert.rejects(repo.undo(change.id, { kind: "user" }), {
    problem: { code: "undo_failed", change: change.id },
  });
  assert.equal(await repo.read("undo-a.md"), "second (still being written)\n");
  const saved = await repo.commitRound("rX", { kind: "router" });
  assert.equal(saved?.summary, "edit undo-a.md");
  assert.equal(await repo.read("undo-a.md"), "second (still being written)\n");
});

test("an undo touching other files keeps a pending round's edits pending", async () => {
  await repo.create("undo-b.md", "temporary\n", "r2");
  const change = await repo.commitRound("r2", { kind: "router" });
  assert.ok(change);
  await repo.edit(
    "MEMORY.md",
    "- [[sim]] simulation lessons\n",
    "- [[sim]] simulation lessons v2\n",
    "rY",
  );

  const undone = await repo.undo(change.id, { kind: "user" });
  assert.equal(await repo.read("undo-b.md"), undefined);
  // The pending file went into neither the undo change nor a user change.
  assert.equal(
    undone.files.some((f) => f.path === "MEMORY.md"),
    false,
  );
  const saved = await repo.commitRound("rY", { kind: "router" });
  assert.equal(saved?.summary, "edit MEMORY.md");
  assert.deepEqual(saved?.source, { kind: "router" });
});

test("versions saved before sources existed still read back with the right source", async () => {
  git("commit", "--quiet", "--allow-empty", "-m", "memory t3: edit a.md");
  git("commit", "--quiet", "--allow-empty", "-m", "dreaming t7: create x.md");
  git("commit", "--quiet", "--allow-empty", "-m", "user edit");
  git("commit", "--quiet", "--allow-empty", "-m", 'Revert "memory t3: edit a.md"');
  const history = await repo.history(4);
  assert.deepEqual(history[0]?.source, { kind: "system" });
  assert.equal(history[0]?.summary, "Undo edit a.md");
  assert.deepEqual(history[1]?.source, { kind: "user" });
  assert.equal(history[1]?.summary, "user edit");
  assert.deepEqual(history[2]?.source, { kind: "dreaming", ticketId: "t7" });
  assert.equal(history[2]?.summary, "create x.md");
  assert.deepEqual(history[3]?.source, { kind: "router", ticketId: "t3" });
  assert.equal(history[3]?.summary, "edit a.md");
});

test("nothing on a change or its detail looks like a hash", async () => {
  const hex = /\b[0-9a-f]{7,40}\b/;
  const history = await repo.history(5);
  for (const change of history) {
    assert.equal(hex.test(JSON.stringify(change)), false, JSON.stringify(change));
    const detail = await repo.show(change.id);
    assert.equal(hex.test(JSON.stringify(detail)), false, JSON.stringify(detail));
  }
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
