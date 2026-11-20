import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type Connection, findEngine } from "../cli/connection.ts";
import { stopEngine } from "../cli/lifecycle.ts";
import { type EeveePaths, eeveePaths } from "../shared/paths.ts";
import { acquireLock, isAlive, readRuntimeRecord } from "./instance.ts";

const entry = fileURLToPath(new URL("../cli/index.ts", import.meta.url));

function launch(home: string, args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...process.env, EEVEE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit").then(([code]) => ({ code, stdout, stderr }));
  return { child, exited };
}

async function ready(paths: EeveePaths, child: ChildProcess): Promise<Connection> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const connection = await findEngine(paths);
    if (connection) return connection;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Engine exited before ready");
    await sleep(50);
  }
  throw new Error("Engine was not ready within 10s");
}

test("detached start is idempotent, status reports the verified identity, and stop waits for exit", {
  timeout: 30_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-detached-"));
  const paths = eeveePaths(home);
  let pid: number | undefined;
  try {
    const first = await launch(home, ["start"]).exited;
    assert.equal(first.code, 0, first.stderr);
    const running = await findEngine(paths);
    assert.ok(running);
    pid = running.record.pid;
    assert.match(first.stdout, /Started: http:\/\/127\.0\.0\.1:[0-9]+\/ui\//);
    assert.notEqual(pid, process.pid);
    const again = await launch(home, ["start"]).exited;
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Already running:/);
    assert.ok(again.stdout.includes(running.baseUrl));
    assert.equal((await readRuntimeRecord(paths.runtime.record))?.pid, pid);
    const foregroundAgain = await launch(home, ["start", "--foreground"]).exited;
    assert.equal(foregroundAgain.code, 0, foregroundAgain.stderr);
    assert.match(foregroundAgain.stdout, /Already running:/);
    const status = await launch(home, ["status"]).exited;
    assert.equal(status.code, 0, status.stderr);
    assert.ok(status.stdout.includes(`pid ${pid}`));
    assert.ok(status.stdout.includes(`port ${running.record.port}`));
    assert.ok(status.stdout.includes(running.record.version));
    assert.ok(status.stdout.includes(running.record.bootId));
    assert.match(status.stdout, /uptime [0-9]+s/);
    assert.equal(
      (first.stdout + again.stdout + status.stdout).includes(running.record.token),
      false,
    );
    const stopped = await launch(home, ["stop"]).exited;
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(stopped.stdout.trim(), "Stopped.");
    assert.equal(isAlive(pid), false);
    assert.equal(await readRuntimeRecord(paths.runtime.record), undefined);
    await assert.rejects(readFile(paths.runtime.lock), { code: "ENOENT" });
    const empty = await launch(home, ["stop"]).exited;
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout.trim(), "The Engine is not running.");
  } finally {
    if (pid !== undefined && isAlive(pid)) {
      await stopEngine(paths).catch(() => false);
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

for (const signal of process.platform === "win32"
  ? [undefined]
  : (["SIGINT", "SIGTERM"] as const)) {
  test(`foreground runs in the CLI process and cleans up on ${signal ?? "HTTP shutdown"}`, {
    timeout: 20_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), "eevee-foreground-"));
    const paths = eeveePaths(home);
    const { child, exited } = launch(home, ["start", "--foreground"]);
    try {
      const running = await ready(paths, child);
      assert.equal(running.record.pid, child.pid);
      if (signal === undefined) await running.client.call("POST /api/engine/shutdown");
      else child.kill(signal);
      const result = await exited;
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Eevee .* is running/);
      assert.ok(result.stdout.includes(`Panel: ${running.baseUrl}/ui/`));
      assert.equal(await readRuntimeRecord(paths.runtime.record), undefined);
      await assert.rejects(readFile(paths.runtime.lock), { code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rm(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}

test("fatal foreground startup releases the lock and permits a later start", {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-startup-failure-"));
  const paths = eeveePaths(home);
  try {
    await writeFile(paths.settings, "{");
    await mkdir(paths.runtime.dir, { recursive: true });
    await writeFile(paths.runtime.record, "stale");
    const failed = await launch(home, ["start", "--foreground"]).exited;
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /JSON|SyntaxError/);
    assert.equal(await readRuntimeRecord(paths.runtime.record), undefined);
    await assert.rejects(readFile(paths.runtime.record), { code: "ENOENT" });
    await assert.rejects(readFile(paths.runtime.lock), { code: "ENOENT" });
    const release = await acquireLock(paths.runtime.lock);
    await release();
    await rm(paths.settings);
    const started = await launch(home, ["start"]).exited;
    assert.equal(started.code, 0, started.stderr);
    assert.equal(await stopEngine(paths), true);
  } finally {
    await stopEngine(paths).catch(() => false);
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
