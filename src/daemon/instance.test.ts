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
