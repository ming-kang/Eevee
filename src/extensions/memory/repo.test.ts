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
  await repo.create("sim.md", "- 仿真步长用 0.1\n", "0");
  await repo.edit("MEMORY.md", "# Memory\n", "# Memory\n- [[sim]] 仿真经验\n", "0");
  await writeFile(join(dir, "notes.md"), "用户自己写的\n");
  await repo.commitRound("0", "memory");
  assert.deepEqual(log().slice(0, 2), ["memory: edit MEMORY.md; create sim.md", "user edit"]);
});

test("各对话的改动分别提交，没结束的那一轮留在工作区", async () => {
  await repo.create("dream.md", "- 整理过的经验\n", "7");
  await repo.create("router.md", "- 用户偏好\n", "0");
  await repo.commitRound("7", "dreaming t2");
  assert.equal(log()[0], "dreaming t2: create dream.md");
  await repo.commitRound("0", "memory");
  assert.equal(log()[0], "memory: create router.md");
});

test("没有改动时提交什么也不做", async () => {
  const before = log().length;
  await repo.commitRound("0", "memory");
  assert.equal(log().length, before);
});

test("原文对不上时拒绝修改并返回最新内容", async () => {
  await assert.rejects(repo.edit("sim.md", "不存在的原文", "x", "0"), (error: unknown) => {
    assert.ok(error instanceof MemoryConflict);
    assert.match(error.current, /仿真步长/);
    return true;
  });
});

test("路径不能越出记忆库", async () => {
  await assert.rejects(repo.create("../escape.md", "x", "0"), /之内/);
});

test("历史按提交列出，撤销一次提交生成反向提交", async () => {
  await repo.create("revert-me.md", "临时\n", "r");
  await repo.commitRound("r", "memory");
  const [latest] = await repo.history(1);
  assert.equal(latest?.subject, "memory: create revert-me.md");
  assert.match(latest?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.match(await repo.diff(latest?.commit), /\+临时/);

  await repo.revert(latest?.commit ?? "");
  assert.equal(await repo.read("revert-me.md"), undefined);
  assert.match(log()[0] ?? "", /^Revert "memory: create revert-me.md"/);
});

test("不是 commit 编号或撤销不了时给出明确错误，不改动仓库", async () => {
  const before = log().length;
  await assert.rejects(repo.revert("--hard"), { problem: { code: "no_commit", commit: "--hard" } });
  await assert.rejects(repo.diff("HEAD~1"), { problem: { code: "no_commit", commit: "HEAD~1" } });
  await assert.rejects(repo.revert("deadbeef"), {
    problem: { code: "revert_failed", commit: "deadbeef" },
  });
  assert.equal(log().length, before);
});

test("listFiles 列出所有记忆文件，MEMORY.md 排第一并排除 .git", async () => {
  await repo.create("topics/optics.md", "- 光学经验\n", "r2");
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
  assert.equal(await repo.read("topics/optics.md"), "- 光学经验\n");
});
