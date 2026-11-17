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

test("本轮的改动合成一个 commit，用户手改单独提交", async () => {
  await repo.create("sim.md", "- 仿真步长用 0.1\n");
  await repo.edit("MEMORY.md", "# Memory\n", "# Memory\n- [[sim]] 仿真经验\n");
  await writeFile(join(dir, "notes.md"), "用户自己写的\n");
  await repo.commitRound();
  assert.deepEqual(log().slice(0, 2), ["memory: edit MEMORY.md; create sim.md", "user edit"]);
});

test("没有改动时提交什么也不做", async () => {
  const before = log().length;
  await repo.commitRound();
  assert.equal(log().length, before);
});

test("原文对不上时拒绝修改并返回最新内容", async () => {
  await assert.rejects(repo.edit("sim.md", "不存在的原文", "x"), (error: unknown) => {
    assert.ok(error instanceof MemoryConflict);
    assert.match(error.current, /仿真步长/);
    return true;
  });
});

test("路径不能越出记忆库", async () => {
  await assert.rejects(repo.create("../escape.md", "x"), /之内/);
});
