import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { GitStore } from "./git.ts";

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "eevee-git-store-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return { dir, git: new GitStore(dir) };
}
const message = (id: number) => ({
  subject: `change ${id}`,
  trailers: { "Eevee-Change": String(id), "Eevee-Source": "user" },
});

test("GitStore initializes only its own repository and reads an empty repository", async (t) => {
  const { dir, git } = await setup(t);
  assert.equal(await git.isRepo(), false);
  await git.init();
  assert.equal(await git.isRepo(), true);
  assert.deepEqual(await git.log(), []);
  assert.deepEqual(await git.changedFiles(), []);
  await mkdir(join(dir, "nested"));
  assert.equal(await new GitStore(join(dir, "nested")).isRepo(), false);
  if (process.platform !== "win32") {
    await symlink(dir, join(dir, "alias"), "dir");
    assert.equal(await new GitStore(join(dir, "alias")).isRepo(), true);
  }
});

test("selected commits isolate files and round-trip dates, subjects and arbitrary trailers", async (t) => {
  const { dir, git } = await setup(t);
  await git.init();
  await writeFile(join(dir, "MEMORY.md"), "one\n");
  const first = await git.commit("all", message(1));
  await writeFile(join(dir, "MEMORY.md"), "two\n");
  await writeFile(join(dir, "münchen notes.md"), "grüße\n");
  execFileSync("git", ["add", "--", "münchen notes.md"], { cwd: dir, windowsHide: true });
  const second = await git.commit(["MEMORY.md"], {
    ...message(2),
    trailers: { ...message(2).trailers, "Reviewed-by": "A Person" },
  });
  assert.deepEqual(await git.changedFiles(), [{ path: "münchen notes.md", status: "added" }]);
  const log = await git.log();
  assert.deepEqual(
    log.map((change) => change.hash),
    [first, second],
  );
  assert.match(log[0]?.at ?? "", /^\d{4}-\d\d-\d\dT/);
  assert.equal(log[1]?.subject, "change 2");
  assert.deepEqual(log[1]?.trailers, { ...message(2).trailers, "Reviewed-by": "A Person" });
  assert.deepEqual(await git.fileChanges(second), [{ path: "MEMORY.md", status: "modified" }]);
  const diff = await git.diff(second);
  assert.equal(diff[0]?.added, 1);
  assert.equal(diff[0]?.removed, 1);
  assert.deepEqual(
    diff[0]?.hunks[0]?.lines.map((line) => line.text),
    ["one", "two"],
  );
  const third = await git.commit("all", message(3));
  assert.equal((await git.diff(third))[0]?.path, "münchen notes.md");
  assert.deepEqual(await git.changedFiles(), []);
});

test("status parses staged renames, deletions, and Windows-safe Unicode paths", async (t) => {
  const { dir, git } = await setup(t);
  await git.init();
  await writeFile(join(dir, "old name.md"), "same\n");
  await writeFile(join(dir, "deleted.md"), "gone\n");
  await git.commit("all", message(1));
  await rename(join(dir, "old name.md"), join(dir, "\u65b0 name.md"));
  await rm(join(dir, "deleted.md"));
  execFileSync("git", ["add", "--all"], { cwd: dir, windowsHide: true });
  assert.deepEqual(
    (await git.changedFiles()).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "deleted.md", status: "deleted" },
      { path: "old name.md", status: "deleted" },
      { path: "\u65b0 name.md", status: "added" },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );
  const hash = await git.commit(["old name.md", "\u65b0 name.md", "deleted.md"], message(2));
  assert.equal(
    (await git.diff(hash)).some((file) => file.path === "\u65b0 name.md"),
    true,
  );
  assert.equal((await git.fileChanges(hash)).length, 3);
  assert.deepEqual(await git.changedFiles(), []);
});

test("literal pathspecs prevent one selected file from matching another", async (t) => {
  const { dir, git } = await setup(t);
  await git.init();
  await writeFile(join(dir, "[x].md"), "literal\n");
  await writeFile(join(dir, "x.md"), "not selected\n");
  const hash = await git.commit(["[x].md"], message(1));
  assert.deepEqual(await git.fileChanges(hash), [{ path: "[x].md", status: "added" }]);
  assert.deepEqual(await git.changedFiles(), [{ path: "x.md", status: "added" }]);
});

test("revert produces an uncommitted inverse for a new ordinary commit", async (t) => {
  const { dir, git } = await setup(t);
  await git.init();
  await writeFile(join(dir, "MEMORY.md"), "one\n");
  const first = await git.commit("all", message(1));
  await writeFile(join(dir, "MEMORY.md"), "two\n");
  const second = await git.commit("all", message(2));
  assert.deepEqual(await git.revert(second), { ok: true });
  assert.equal(await readFile(join(dir, "MEMORY.md"), "utf8"), "one\n");
  assert.equal((await git.log()).length, 2);
  const third = await git.commit(["MEMORY.md"], message(3));
  assert.deepEqual(
    (await git.log()).map((change) => change.hash),
    [first, second, third],
  );
});

test("a revert conflict aborts without changing files, history or the index", async (t) => {
  const { dir, git } = await setup(t);
  await git.init();
  const hashes: string[] = [];
  for (const [index, content] of ["one\n", "two\n", "three\n"].entries()) {
    await writeFile(join(dir, "MEMORY.md"), content);
    hashes.push(await git.commit("all", message(index + 1)));
  }
  assert.deepEqual(await git.revert(hashes[1] as string), { conflict: true });
  assert.equal(await readFile(join(dir, "MEMORY.md"), "utf8"), "three\n");
  assert.deepEqual(await git.changedFiles(), []);
  assert.deepEqual(
    (await git.log()).map((change) => change.hash),
    hashes,
  );
  await assert.rejects(readFile(join(dir, ".git", "REVERT_HEAD")), { code: "ENOENT" });
  await assert.rejects(git.revert("--all"), /Invalid revision/);
  await assert.rejects(git.diff("not-a-hash"), /Invalid revision/);
});
