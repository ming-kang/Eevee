import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { requestSupervisorStop } from "../src/daemon.ts";
import {
  dataDirLayout,
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

test("concurrent stale-lock recovery selects exactly one valid lock holder without breaking the winner's lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-concurrent-stale-lock-"));
  const lockFile = join(dir, "engine.lock");
  try {
    const stalePid = await deadPid();

    await writeFile(lockFile, JSON.stringify({ pid: stalePid, token: "dead-1" }), "utf8");
    const settled = await Promise.allSettled([
      acquireProcessLock(lockFile),
      acquireProcessLock(lockFile),
    ]);
    const winners = settled.filter((r) => r.status === "fulfilled");
    const losers = settled.filter((r) => r.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    if (losers[0]?.status === "rejected") {
      assert.match(String(losers[0].reason), /holds lock/);
    }
    const owner = JSON.parse(await readFile(lockFile, "utf8")) as { pid: number; token: string };
    assert.equal(owner.pid, process.pid);
    if (winners[0]?.status === "fulfilled") {
      await winners[0].value.release();
    }

    await writeFile(lockFile, JSON.stringify({ pid: stalePid, token: "dead-2" }), "utf8");
    const lockModuleUrl = pathToFileURL(join(import.meta.dirname, "../src/process-lock.ts")).href;
    const workerScript = `
      import { acquireProcessLock } from ${JSON.stringify(lockModuleUrl)};
      const lockFile = process.argv[1];
      const lock = await acquireProcessLock(lockFile, { timeoutMs: 5000 });
      const acquiredAt = Date.now();
      await new Promise((r) => setTimeout(r, 120));
      const releasedAt = Date.now();
      await lock.release();
      console.log(JSON.stringify({ pid: process.pid, acquiredAt, releasedAt }));
    `;
    const runChild = () =>
      new Promise<{ pid: number; acquiredAt: number; releasedAt: number }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--conditions=eevee-source", "--input-type=module", "-e", workerScript, lockFile],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== 0) {
            reject(new Error(`Child exited ${code}: ${stderr}`));
            return;
          }
          resolve(
            JSON.parse(stdout.trim()) as { pid: number; acquiredAt: number; releasedAt: number },
          );
        });
      });

    const [a, b] = await Promise.all([runChild(), runChild()]);
    assert.notEqual(a.pid, b.pid);
    const [first, second] = a.acquiredAt <= b.acquiredAt ? [a, b] : [b, a];
    assert.ok(
      second.acquiredAt >= first.releasedAt - 5,
      `Lock overlap detected: first=${JSON.stringify(first)}, second=${JSON.stringify(second)}`,
    );

    const after = await acquireProcessLock(lockFile);
    await after.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runSupervisor responds cleanly to requestSupervisorStop via fs.watch and cleans up state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eevee-supervisor-watch-"));
  const layout = dataDirLayout(dir);
  const readyFile = join(dir, "child.ready");
  const stubCli = join(dir, "stub-cli.mjs");
  await writeFile(
    stubCli,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.STUB_READY_FILE, String(process.pid), "utf8");
process.on("message", (msg) => {
  if (msg && msg.type === "eevee:shutdown") process.exit(0);
});
setInterval(() => {}, 1000);
`,
    "utf8",
  );

  const supervisorUrl = pathToFileURL(join(import.meta.dirname, "../src/supervisor.ts")).href;
  const runnerScript = join(dir, "run-supervisor.mjs");
  await writeFile(
    runnerScript,
    `import { runSupervisor } from ${JSON.stringify(supervisorUrl)};
await runSupervisor({
  dataDir: process.argv[2],
  cliEntry: process.argv[3],
  port: 0,
  env: { STUB_READY_FILE: process.argv[4] },
});
`,
    "utf8",
  );
  const supervisorProc = spawn(
    process.execPath,
    ["--conditions=eevee-source", runnerScript, dir, stubCli, readyFile],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  supervisorProc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exited = new Promise<number | null>((resolve, reject) => {
    supervisorProc.once("error", reject);
    supervisorProc.once("exit", (code) => resolve(code));
  });

  try {
    const deadline = Date.now() + 10_000;
    let enginePid: number | undefined;
    while (Date.now() < deadline) {
      const state = await readSupervisorState(layout.supervisorStateFile);
      if (state?.enginePid !== undefined) {
        try {
          const readyPid = Number((await readFile(readyFile, "utf8")).trim());
          if (readyPid === state.enginePid) {
            enginePid = readyPid;
            break;
          }
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(enginePid !== undefined, `supervisor child did not start cleanly: ${stderr}`);

    await requestSupervisorStop(layout);
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Supervisor did not exit in time: ${stderr}`)), 5_000),
      ),
    ]);
    assert.equal(code, 0, stderr);
    assert.equal(isProcessAlive(enginePid), false);
    assert.equal(await readSupervisorState(layout.supervisorStateFile), undefined);
  } finally {
    if (supervisorProc.exitCode === null && supervisorProc.signalCode === null) {
      supervisorProc.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
