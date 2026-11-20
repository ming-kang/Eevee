import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  acquireLock,
  InstanceLocked,
  type RuntimeRecord,
  readRuntimeRecord,
  removeRuntimeRecord,
  writeRuntimeRecord,
} from "./instance.ts";

const dirs: string[] = [];

async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-lock-"));
  dirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("only one of many concurrent lock attempts wins; the rest see the holder", async () => {
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

test("the lock can be reacquired after release", async () => {
  const path = join(await temporary(), "instance.lock");
  const release = await acquireLock(path);
  await release();
  await assert.rejects(readFile(path, "utf8"));
  const again = await acquireLock(path);
  await again();
});

test("release deletes only its own lock", async () => {
  const path = join(await temporary(), "instance.lock");
  const release = await acquireLock(path);
  const other = JSON.stringify({ pid: process.pid, host: hostname(), token: "other" });
  await writeFile(path, other);
  await release();
  assert.equal(await readFile(path, "utf8"), other);
});

test("a lock whose process is gone is reclaimed", async () => {
  const path = join(await temporary(), "instance.lock");
  await writeFile(path, JSON.stringify({ pid: 2 ** 22 + 7919, host: hostname(), token: "dead" }));
  const release = await acquireLock(path);
  const owner = JSON.parse(await readFile(path, "utf8")) as { pid: number; token: string };
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, "dead");
  await release();
});

test("runtime records round-trip privately and removal cannot delete a replacement", async () => {
  const path = join(await temporary(), "engine.json");
  assert.equal(await readRuntimeRecord(path), undefined);
  const record: RuntimeRecord = {
    pid: process.pid,
    port: 19190,
    version: "test",
    bootId: "boot-1",
    token: "test-token",
    startedAt: Date.now(),
  };
  await writeRuntimeRecord(path, record);
  assert.deepEqual(await readRuntimeRecord(path), record);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, "old public content", { mode: 0o644 });
  if (process.platform !== "win32") await chmod(path, 0o644);
  await writeRuntimeRecord(path, record);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  const next = { ...record, bootId: "boot-2", token: "new-token" };
  await writeRuntimeRecord(path, next);
  await removeRuntimeRecord(path, record);
  assert.deepEqual(await readRuntimeRecord(path), next);
  await removeRuntimeRecord(path, next);
  assert.equal(await readRuntimeRecord(path), undefined);
  await writeFile(path, "{");
  assert.equal(await readRuntimeRecord(path), undefined);
  await writeFile(path, JSON.stringify({ ...record, pid: 0 }));
  assert.equal(await readRuntimeRecord(path), undefined);
});
