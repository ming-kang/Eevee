import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getDaemonStatus,
  isProcessAlive,
  readEngineState,
  readSupervisorState,
  startForegroundEngine,
  stopDaemon,
  writeEngineState,
  writeSupervisorState,
} from "../src/index.ts";
import { acquireProcessLock } from "../src/process-lock.ts";

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  assert.ok(child.pid !== undefined);
  assert.equal(isProcessAlive(child.pid), false);
  return child.pid;
}

test("process locks reject live owners, release cleanly, and recover dead owners", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-process-lock-"));
  const lockFile = join(dir, "engine.lock");
  try {
    const first = await acquireProcessLock(lockFile);
    await assert.rejects(acquireProcessLock(lockFile), /holds lock/);
    await first.release();
    await first.release();

    const pid = await deadPid();
    await writeFile(lockFile, JSON.stringify({ pid, token: "dead" }), "utf8");
    const recovered = await acquireProcessLock(lockFile);
    const owner = JSON.parse(await readFile(lockFile, "utf8")) as { pid: number };
    assert.equal(owner.pid, process.pid);
    await recovered.release();

    const reacquired = await acquireProcessLock(lockFile);
    await reacquired.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop refuses to signal a live process that cannot prove Engine identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-foreign-engine-"));
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    assert.ok(sentinel.pid !== undefined);
    await writeEngineState(join(dir, "engine.json"), {
      pid: sentinel.pid,
      host: "127.0.0.1",
      port: 1,
      url: "http://127.0.0.1:1",
      protocolVersion: 1,
      engineVersion: "0.0.1",
      startedAt: 1,
    });
    await assert.rejects(stopDaemon({ dataDir: dir, timeoutMs: 100 }), /verify|refus/i);
    assert.equal(isProcessAlive(sentinel.pid), true);
  } finally {
    sentinel.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live lock owner without a fresh heartbeat is recoverable after PID reuse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-reused-lock-"));
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    assert.ok(sentinel.pid !== undefined);
    const lockFile = join(dir, "engine.lock");
    await writeFile(lockFile, JSON.stringify({ pid: sentinel.pid, token: "old-owner" }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);
    const lock = await acquireProcessLock(lockFile);
    assert.equal(isProcessAlive(sentinel.pid), true);
    await lock.release();
  } finally {
    sentinel.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon status honors stopping and supervisor/Engine ownership before health", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-status-ownership-"));
  const foreground = await startForegroundEngine({
    dataDir: dir,
    port: 0,
    recoverProjects: false,
  });
  try {
    await writeSupervisorState(join(dir, "supervisor.json"), {
      pid: process.pid,
      enginePid: foreground.state.pid,
      port: foreground.state.port,
      startedAt: 1,
      restartCount: 0,
      stopping: true,
    });
    assert.equal((await getDaemonStatus({ dataDir: dir })).status, "stopping");

    await writeSupervisorState(join(dir, "supervisor.json"), {
      pid: process.pid,
      enginePid: foreground.state.pid + 1,
      port: foreground.state.port,
      startedAt: 1,
      restartCount: 0,
      stopping: false,
    });
    const mismatched = await getDaemonStatus({ dataDir: dir });
    assert.notEqual(mismatched.status, "running");
    assert.equal(mismatched.supervisorPid, process.pid);
    assert.equal(mismatched.enginePid, foreground.state.pid + 1);
  } finally {
    await foreground.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon status and stop clean stale supervisor and Engine state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-stale-daemon-"));
  try {
    const [supervisorPid, enginePid] = await Promise.all([deadPid(), deadPid()]);
    await writeSupervisorState(join(dir, "supervisor.json"), {
      pid: supervisorPid,
      enginePid,
      port: 4173,
      startedAt: 1,
      restartCount: 2,
      stopping: false,
    });
    await writeEngineState(join(dir, "engine.json"), {
      pid: enginePid,
      host: "127.0.0.1",
      port: 4173,
      url: "http://127.0.0.1:4173",
      protocolVersion: 1,
      engineVersion: "0.0.1",
      startedAt: 1,
    });

    assert.deepEqual(await getDaemonStatus({ dataDir: dir }), {
      status: "stopped",
      restartCount: 0,
    });
    assert.deepEqual(await stopDaemon({ dataDir: dir }), { outcome: "already_stopped" });
    assert.equal(await readSupervisorState(join(dir, "supervisor.json")), undefined);
    assert.equal(await readEngineState(join(dir, "engine.json")), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
