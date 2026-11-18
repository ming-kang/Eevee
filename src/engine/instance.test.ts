import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { acquireLock, InstanceLocked } from "./instance.ts";

const dirs: string[] = [];

async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-lock-"));
  dirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("并发获取实例锁只有一个成功，其余看到持有者", async () => {
  const path = join(await temporary(), "instance.lock");
  const results = await Promise.allSettled(Array.from({ length: 24 }, () => acquireLock(path)));
  const won = results.filter((result) => result.status === "fulfilled");
  assert.equal(won.length, 1);
  const lost = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(lost.every((result) => result.reason instanceof InstanceLocked));
  const owner = JSON.parse(await readFile(path, "utf8")) as { pid: number };
  assert.equal(owner.pid, process.pid);
});

test("释放后可以重新获取", async () => {
  const path = join(await temporary(), "instance.lock");
  const release = await acquireLock(path);
  await release();
  await assert.rejects(readFile(path, "utf8"));
  const again = await acquireLock(path);
  await again();
});

test("释放只删自己的锁", async () => {
  const path = join(await temporary(), "instance.lock");
  const release = await acquireLock(path);
  const other = JSON.stringify({ pid: process.pid, host: hostname(), token: "other" });
  await writeFile(path, other);
  await release();
  assert.equal(await readFile(path, "utf8"), other);
});

test("进程已经不在了的锁会被回收", async () => {
  const path = join(await temporary(), "instance.lock");
  await writeFile(path, JSON.stringify({ pid: 2 ** 22 + 7919, host: hostname(), token: "dead" }));
  const release = await acquireLock(path);
  const owner = JSON.parse(await readFile(path, "utf8")) as { pid: number; token: string };
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, "dead");
  await release();
});
