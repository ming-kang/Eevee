import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import type { MemorySource } from "../../domain/index.ts";
import { GitStore } from "./git.ts";
import { MemoryRound } from "./round.ts";
import { MemoryConflict, type MemoryPolicy, MemoryStore } from "./store.ts";

let dir: string;
let repo: MemoryStore;
const subjects = () =>
  execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
const rounds = new Map<string, MemoryRound>();
function pending(id: string): MemoryRound {
  let round = rounds.get(id);
  if (!round) {
    round = new MemoryRound(repo);
    rounds.set(id, round);
  }
  return round;
}
const create = (file: string, content: string, round: string) =>
  pending(round).add({ action: "create", file, content });
const edit = (file: string, oldText: string, newText: string, round: string) =>
  pending(round).add({ action: "edit", file, oldText, newText });
const flush = (round: string, source: MemorySource) => pending(round).flush(source);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "eevee-memory-"));
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "eevee-test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "eevee@test.invalid";
  repo = new MemoryStore(dir);
  await repo.ensure("# Memory\n");
});

after(() => rm(dir, { recursive: true, force: true }));

test("a run's edits become one change, and a user's own edit becomes a separate user change", async () => {
  await create("sim.md", "- simulation step 0.1\n", "0");
  await edit("MEMORY.md", "# Memory\n", "# Memory\n- [[sim]] simulation lessons\n", "0");
  await writeFile(join(dir, "notes.md"), "written by the user\n");
  const change = await flush("0", { kind: "router" });
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

test("each conversation saves its own change with its source, and unfinished rounds stay out of the workspace", async () => {
  await create("dream.md", "- tidied lessons\n", "7");
  await create("router.md", "- user preferences\n", "0");
  assert.equal(await repo.read("dream.md"), undefined);
  assert.equal(await repo.read("router.md"), undefined);
  const dreaming = await flush("7", { kind: "dreaming", ticketId: "t2" });
  assert.deepEqual(dreaming?.source, { kind: "dreaming", ticketId: "t2" });
  assert.equal(dreaming?.summary, "create dream.md");
  const router = await flush("0", { kind: "router", ticketId: "t3" });
  assert.deepEqual(router?.source, { kind: "router", ticketId: "t3" });
  assert.equal(router?.summary, "create router.md");
});

test("saving does nothing when there are no changes", async () => {
  const before = subjects().length;
  assert.equal(await flush("0", { kind: "router" }), undefined);
  assert.equal(subjects().length, before);
});

test("an edit is refused when the original text does not match, and the latest content comes back", async () => {
  await assert.rejects(edit("sim.md", "text that is not there", "x", "0"), (error: unknown) => {
    assert.ok(error instanceof MemoryConflict);
    assert.match(error.current, /simulation step/);
    return true;
  });
});

test("a path cannot escape the memory store", async () => {
  await assert.rejects(create("../escape.md", "x", "0"), /must stay inside/);
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

test("reading history mid-run commits neither hand edits nor pending operations", async () => {
  await create("pending.md", "- mid-run note\n", "mid");
  await writeFile(join(dir, "manual.md"), "touched by hand\n");
  const during = await repo.history(5);
  const userChange = during.find(
    (c) => c.source.kind === "user" && c.summary.includes("manual.md"),
  );
  assert.equal(userChange, undefined);
  assert.equal(await repo.read("pending.md"), undefined);
  const change = await flush("mid", { kind: "router" });
  assert.equal(change?.summary, "create pending.md");
  assert.deepEqual(
    (await repo.history(2))[1]?.files.map((file) => file.path),
    ["manual.md"],
  );
});

test("show gives the structured edits of a change, including non-ASCII file names", async () => {
  await create("münchen.md", "grüße\n", "u");
  await edit("sim.md", "- simulation step 0.1\n", "- simulation step 0.2\n", "u");
  await writeFile(join(dir, "to-delete.md"), "gone soon\n");
  await flush("pre-del", { kind: "router" });
  await pending("u").add({ action: "delete", file: "to-delete.md" });
  const change = await flush("u", { kind: "router" });
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
  await create("undo-me.md", "temporary\n", "r");
  const change = await flush("r", { kind: "router" });
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
  await create("conflict.md", "original\n", "c1");
  await flush("c1", { kind: "router" });
  await edit("conflict.md", "original\n", "changed\n", "c2");
  const change = await flush("c2", { kind: "router" });
  assert.ok(change);
  await edit("conflict.md", "changed\n", "changed again\n", "c3");
  await flush("c3", { kind: "router" });

  const count = (await repo.history(50)).length;
  const content = await repo.read("conflict.md");
  await assert.rejects(repo.undo(change.id, { kind: "user" }), {
    problem: { code: "undo_failed", change: change.id },
  });
  assert.equal(await repo.read("conflict.md"), content);
  assert.equal((await repo.history(50)).length, count);
});

test("a failed undo keeps a pending round's unsaved edits", async () => {
  await create("undo-a.md", "first\n", "r1");
  const change = await flush("r1", { kind: "router" });
  assert.ok(change);
  await repo.apply([{ action: "write", file: "undo-a.md", content: "second\n" }], {
    kind: "router",
  });
  await edit("undo-a.md", "second\n", "second (still being written)\n", "rX");

  await assert.rejects(repo.undo(change.id, { kind: "user" }), {
    problem: { code: "undo_failed", change: change.id },
  });
  assert.equal(await repo.read("undo-a.md"), "second\n");
  const saved = await flush("rX", { kind: "router" });
  assert.equal(saved?.summary, "edit undo-a.md");
  assert.equal(await repo.read("undo-a.md"), "second (still being written)\n");
});

test("an undo touching other files keeps a pending round's edits pending", async () => {
  await create("undo-b.md", "temporary\n", "r2");
  const change = await flush("r2", { kind: "router" });
  assert.ok(change);
  await edit(
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
  const saved = await flush("rY", { kind: "router" });
  assert.equal(saved?.summary, "edit MEMORY.md");
  assert.deepEqual(saved?.source, { kind: "router" });
});

test("a fresh repository without an init trailer starts at change 1 without subject parsing", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-memory-init-"));
  try {
    const versions = new GitStore(home);
    await versions.init();
    await writeFile(join(home, "MEMORY.md"), "initial\n");
    await versions.commit("all", { subject: "an arbitrary initial subject", trailers: {} });
    const memory = new MemoryStore(home);
    await memory.ensure("not used");
    const history = await memory.history();
    assert.equal(history.length, 1);
    assert.equal(history[0]?.id, 1);
    assert.equal(history[0]?.summary, "init");
    assert.deepEqual(history[0]?.source, { kind: "system" });
    const next = await memory.apply([{ action: "write", file: "MEMORY.md", content: "next\n" }], {
      kind: "router",
    });
    assert.equal(next?.id, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
  await create("topics/optics.md", "- optics lessons\n", "r2");
  await flush("r2", { kind: "router" });
  const files = await repo.files();
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

async function isolated(t: TestContext, policy: MemoryPolicy = "project") {
  const dir = await mkdtemp(join(tmpdir(), "eevee-memory-store-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const store = new MemoryStore(dir, policy);
  await store.ensure("alpha\nbeta\n");
  return { dir, store, versions: new GitStore(dir) };
}

test("concurrent rounds on the same file save only their own edits and sources", async (t) => {
  const { dir, store } = await isolated(t);
  const router = new MemoryRound(store);
  const dreamer = new MemoryRound(new MemoryStore(dir));
  await router.add({ action: "edit", file: "MEMORY.md", oldText: "alpha", newText: "router" });
  await dreamer.add({ action: "edit", file: "MEMORY.md", oldText: "beta", newText: "dreamer" });
  assert.equal(await store.read("MEMORY.md"), "alpha\nbeta\n");
  const [a, b] = await Promise.all([
    router.flush({ kind: "router", ticketId: "t1" }),
    dreamer.flush({ kind: "dreaming", ticketId: "t2" }),
  ]);
  assert.ok(a && b);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(a.source, { kind: "router", ticketId: "t1" });
  assert.deepEqual(b.source, { kind: "dreaming", ticketId: "t2" });
  assert.equal(await store.read("MEMORY.md"), "router\ndreamer\n");
  for (const [id, expected] of [
    [a.id, ["alpha", "router"]],
    [b.id, ["beta", "dreamer"]],
  ] as const) {
    const detail = await store.show(id);
    assert.deepEqual(
      detail.files.flatMap((file) =>
        file.hunks.flatMap((hunk) =>
          hunk.lines.filter((line) => line.kind !== "context").map((line) => line.text),
        ),
      ),
      expected,
    );
  }
  assert.equal((await store.history()).length, 3);
});

test("a stale concurrent round conflicts atomically without stealing attribution", async (t) => {
  const { store } = await isolated(t);
  const first = new MemoryRound(store);
  const stale = new MemoryRound(store);
  await first.add({ action: "edit", file: "MEMORY.md", oldText: "alpha", newText: "first" });
  await stale.add({ action: "create", file: "must-not-exist.md", content: "pending" });
  await stale.add({ action: "edit", file: "MEMORY.md", oldText: "alpha", newText: "stale" });
  const saved = await first.flush({ kind: "router" });
  await assert.rejects(stale.flush({ kind: "dreaming", ticketId: "t2" }), (error: unknown) => {
    assert.ok(error instanceof MemoryConflict);
    assert.equal(error.file, "MEMORY.md");
    assert.equal(error.current, "first\nbeta\n");
    return true;
  });
  assert.equal(await store.read("must-not-exist.md"), undefined);
  assert.equal((await store.history()).length, 2);
  assert.deepEqual((await store.history(1))[0], saved);
});

test("parallel additions to one round validate sequential operations and recover from errors", async (t) => {
  const { store } = await isolated(t);
  const round = new MemoryRound(store);
  await Promise.all([
    round.add({ action: "create", file: "round.md", content: "one" }),
    round.add({ action: "edit", file: "round.md", oldText: "one", newText: "two" }),
  ]);
  await assert.rejects(round.add({ action: "delete", file: "missing.md" }), MemoryConflict);
  await round.add({ action: "rename", from: "round.md", to: "nested/final.md" });
  const saved = await round.flush({ kind: "router" });
  assert.equal(saved?.summary, "create nested/final.md");
  assert.equal(await store.read("nested/final.md"), "two");
  assert.equal(await round.flush({ kind: "router" }), undefined);
});

test("apply validates the entire batch before writing any files or capturing hand edits", async (t) => {
  const { dir, store, versions } = await isolated(t);
  await writeFile(join(dir, "hand.md"), "hand written");
  const original = await versions.log();
  await assert.rejects(
    store.apply(
      [
        { action: "write", file: "MEMORY.md", content: "must not be written" },
        { action: "create", file: "new.md", content: "must not be created" },
        { action: "edit", file: "hand.md", oldText: "not found", newText: "bad" },
      ],
      { kind: "router" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof MemoryConflict);
      assert.equal(error.file, "hand.md");
      assert.equal(error.current, "hand written");
      return true;
    },
  );
  assert.equal(await store.read("MEMORY.md"), "alpha\nbeta\n");
  assert.equal(await store.read("new.md"), undefined);
  assert.equal(await store.read("hand.md"), "hand written");
  assert.deepEqual(await versions.log(), original);
  for (const ops of [
    [
      { action: "create", file: "x", content: "x" },
      { action: "create", file: "x/nested.md", content: "bad" },
    ],
    [
      { action: "create", file: "x/nested.md", content: "x" },
      { action: "write", file: "x", content: "bad" },
    ],
  ] as const)
    await assert.rejects(store.apply(ops, { kind: "user" }), MemoryConflict);
  assert.equal(await store.read("x"), undefined);
});

test("create, edit, write, delete and rename compose and can be undone", async (t) => {
  const { store } = await isolated(t);
  const created = await store.apply(
    [
      { action: "create", file: "draft.md", content: "old" },
      { action: "edit", file: "draft.md", oldText: "old", newText: "edited" },
      { action: "write", file: "draft.md", content: "final\n" },
    ],
    { kind: "router" },
  );
  assert.ok(created);
  const renamed = await store.apply(
    [{ action: "rename", from: "draft.md", to: "topics/new name.md" }],
    { kind: "router" },
  );
  assert.ok(renamed);
  assert.equal(await store.read("draft.md"), undefined);
  assert.equal(await store.read("topics/new name.md"), "final\n");
  assert.equal(
    (await store.show(renamed.id)).files.some((file) => file.path === "topics/new name.md"),
    true,
  );
  await store.undo(renamed.id, { kind: "user" });
  assert.equal(await store.read("draft.md"), "final\n");
  assert.equal(await store.read("topics/new name.md"), undefined);
  const deleted = await store.apply([{ action: "delete", file: "draft.md" }], { kind: "router" });
  assert.ok(deleted);
  assert.equal(deleted.files[0]?.status, "deleted");
  await store.undo(deleted.id, { kind: "user" });
  assert.equal(await store.read("draft.md"), "final\n");
  await assert.rejects(
    store.apply([{ action: "create", file: "draft.md", content: "duplicate" }], { kind: "user" }),
    MemoryConflict,
  );
  await assert.rejects(
    store.apply([{ action: "rename", from: "draft.md", to: "MEMORY.md" }], { kind: "user" }),
    MemoryConflict,
  );
  await assert.rejects(
    store.apply([{ action: "delete", file: "missing.md" }], { kind: "user" }),
    MemoryConflict,
  );
  await assert.rejects(
    store.apply([{ action: "rename", from: "missing.md", to: "new.md" }], { kind: "user" }),
    MemoryConflict,
  );
});

test("edit requires exactly one nonempty match, including overlapping matches", async (t) => {
  const { store } = await isolated(t);
  await store.apply([{ action: "write", file: "MEMORY.md", content: "aaa" }], { kind: "user" });
  for (const oldText of ["", "aa", "absent"]) {
    await assert.rejects(
      store.apply([{ action: "edit", file: "MEMORY.md", oldText, newText: "x" }], {
        kind: "router",
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryConflict);
        assert.equal(error.current, "aaa");
        return true;
      },
    );
  }
  assert.equal(await store.read("MEMORY.md"), "aaa");
});

test("history, show, files and read have no side effects; captureUserEdits is explicit", async (t) => {
  const { dir, store, versions } = await isolated(t);
  const original = await versions.log();
  await writeFile(join(dir, "MEMORY.md"), "hand edited\n");
  await writeFile(join(dir, "manual.md"), "new hand note\n");
  assert.equal((await store.history()).length, 1);
  assert.equal((await store.show(1)).id, 1);
  assert.equal((await store.files()).length, 2);
  assert.equal(await store.read("MEMORY.md"), "hand edited\n");
  assert.equal(await store.read("missing.md"), undefined);
  assert.deepEqual(await store.file("./MEMORY.md"), {
    path: "MEMORY.md",
    content: "hand edited\n",
  });
  assert.deepEqual(await versions.log(), original);
  const captured = await store.captureUserEdits();
  assert.equal(captured?.source.kind, "user");
  assert.equal(captured?.files.length, 2);
  assert.equal(await store.captureUserEdits(), undefined);
  assert.equal(await store.apply([], { kind: "router" }), undefined);
  assert.deepEqual(await store.history(0), []);
});

test("applying an edit or full write first captures the same file's hand edits separately", async (t) => {
  const { dir, store } = await isolated(t);
  await writeFile(join(dir, "MEMORY.md"), "hand edit\n");
  await store.apply([{ action: "edit", file: "MEMORY.md", oldText: "hand", newText: "router" }], {
    kind: "router",
  });
  let history = await store.history();
  assert.equal(history[0]?.source.kind, "router");
  assert.equal(history[1]?.source.kind, "user");
  await writeFile(join(dir, "MEMORY.md"), "another hand edit\n");
  const saved = await store.apply(
    [{ action: "write", file: "MEMORY.md", content: "full replacement\n" }],
    { kind: "dreaming", ticketId: "t4" },
    "A concise summary",
  );
  history = await store.history();
  assert.equal(saved?.summary, "A concise summary");
  assert.deepEqual(history[0]?.source, { kind: "dreaming", ticketId: "t4" });
  assert.equal(history[1]?.source.kind, "user");
  assert.equal(await store.read("MEMORY.md"), "full replacement\n");
  assert.equal(
    await store.apply([{ action: "write", file: "MEMORY.md", content: "full replacement\n" }], {
      kind: "router",
    }),
    undefined,
  );
});

test("global policy is enforced for every operation, including undo and hand-edit capture", async (t) => {
  const { dir, store, versions } = await isolated(t, "global");
  await writeFile(join(dir, "other.md"), "not a global memory file");
  for (const op of [
    { action: "create", file: "other.md", content: "x" },
    { action: "write", file: "other.md", content: "x" },
    { action: "edit", file: "other.md", oldText: "not", newText: "x" },
    { action: "delete", file: "other.md" },
    { action: "rename", from: "MEMORY.md", to: "other.md" },
    { action: "rename", from: "other.md", to: "MEMORY.md" },
  ] as const)
    await assert.rejects(store.apply([op], { kind: "user" }), MemoryConflict);
  await assert.rejects(store.read("other.md"), {
    problem: { code: "no_memory_file", file: "other.md" },
  });
  assert.deepEqual(
    (await store.files()).map((file) => file.path),
    ["MEMORY.md"],
  );
  assert.equal(await store.captureUserEdits(), undefined);
  const change = await store.apply([{ action: "write", file: "MEMORY.md", content: "allowed\n" }], {
    kind: "router",
  });
  assert.ok(change);
  await store.undo(change.id, { kind: "user" });
  assert.equal(await store.read("MEMORY.md"), "alpha\nbeta\n");
  assert.deepEqual(await versions.changedFiles(), [{ path: "other.md", status: "added" }]);
  await store.apply([{ action: "delete", file: "MEMORY.md" }], { kind: "user" });
  assert.deepEqual(await store.files(), []);
  await store.apply([{ action: "create", file: "MEMORY.md", content: "recreated" }], {
    kind: "user",
  });
  assert.equal(await store.read("MEMORY.md"), "recreated");
});

test("store paths exclude traversal, Git internals, directories and symlinks", async (t) => {
  const { dir, store } = await isolated(t);
  for (const file of [
    "../escape.md",
    join(dir, "absolute.md"),
    "C:\\escape.md",
    "x\\..\\..\\escape.md",
    ".git/HEAD",
    ".GIT/config",
    ".git./config",
    ".git:stream",
    ".",
  ]) {
    await assert.rejects(
      store.apply([{ action: "write", file, content: "bad" }], { kind: "router" }),
      MemoryConflict,
    );
  }
  await mkdir(join(dir, "folder"));
  await assert.rejects(
    store.apply([{ action: "write", file: "folder", content: "bad" }], { kind: "router" }),
    MemoryConflict,
  );
  if (process.platform !== "win32") {
    await symlink(join(dir, ".git"), join(dir, "linked"));
    await assert.rejects(
      store.apply([{ action: "write", file: "linked/config", content: "bad" }], { kind: "router" }),
      MemoryConflict,
    );
    await assert.rejects(store.read("linked/config"), {
      problem: { code: "no_memory_file", file: "linked/config" },
    });
    assert.equal(
      (await store.files()).some((file) => file.path.startsWith("linked/")),
      false,
    );
  }
  assert.equal(await store.read("MEMORY.md"), "alpha\nbeta\n");
});

test("change IDs survive history position changes and undo appends rather than amending", async (t) => {
  const { dir, store, versions } = await isolated(t);
  await writeFile(join(dir, "MEMORY.md"), "number forty-one\n");
  const hash = await versions.commit(["MEMORY.md"], {
    subject: "memory t3: this is not source metadata",
    trailers: { "Eevee-Change": "41", "Eevee-Source": "dreaming", "Eevee-Ticket": "t8" },
  });
  assert.deepEqual(
    (await store.history()).map((change) => change.id),
    [41, 1],
  );
  const detail = await store.show(41);
  assert.deepEqual(detail.source, { kind: "dreaming", ticketId: "t8" });
  assert.equal(detail.summary, "memory t3: this is not source metadata");
  await assert.rejects(store.show(2), { problem: { code: "no_change", change: 2 } });
  const undone = await store.undo(41, { kind: "user" });
  assert.equal(undone.id, 42);
  assert.equal(await store.read("MEMORY.md"), "alpha\nbeta\n");
  const log = await versions.log();
  assert.deepEqual(
    log.map((change) => change.trailers["Eevee-Change"]),
    ["1", "41", "42"],
  );
  assert.equal(log[1]?.hash, hash);
  assert.equal(
    log.every((change) => change.trailers["Eevee-Source"]),
    true,
  );
});
