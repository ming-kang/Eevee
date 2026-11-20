import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  acquireLock,
  type RuntimeRecord,
  readRuntimeRecord,
  writeRuntimeRecord,
} from "../daemon/instance.ts";
import { eeveePaths } from "../shared/paths.ts";
import { findEngine } from "./connection.ts";
import { startEngine, stopEngine, waitForExit } from "./lifecycle.ts";

const recordFor = (pid: number, port = 19190): RuntimeRecord => ({
  pid,
  port,
  bootId: "boot",
  version: "test",
  token: "test-token",
  startedAt: Date.now(),
});

test("a losing detached start waits for the live lock owner's runtime record", {
  timeout: 10_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-overlapping-start-"));
  const paths = eeveePaths(home);
  const release = await acquireLock(paths.runtime.lock);
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ bootId: "boot", version: "test" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let settled = false;
  const starting = startEngine(paths).finally(() => {
    settled = true;
  });
  void starting.catch(() => undefined);
  try {
    let log = "";
    for (let i = 0; i < 500 && !log.includes("already running"); i++) {
      await sleep(10);
      log = await readFile(join(paths.runtime.dir, "engine.log"), "utf8").catch(() => "");
    }
    assert.match(log, /already running/);
    await sleep(350);
    assert.equal(settled, false, "the losing CLI must wait while another instance owns the lock");
    await writeRuntimeRecord(paths.runtime.record, recordFor(process.pid, address.port));
    const result = await starting;
    assert.equal(result?.connection.record.pid, process.pid);
    assert.equal(result?.started, false);
  } finally {
    await release();
    await starting.catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a detached child startup failure without a live lock still fails fast", {
  timeout: 10_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-detached-failure-"));
  const paths = eeveePaths(home);
  try {
    await writeFile(paths.settings, "{");
    await assert.rejects(startEngine(paths), /exited before becoming ready/);
    await assert.rejects(readFile(paths.runtime.lock), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("discovery cleans dead and boot-mismatched records without a separate token file", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-discovery-"));
  const paths = eeveePaths(home);
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ bootId: "actual", version: "test" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    assert.equal(await findEngine(paths), undefined);
    await writeRuntimeRecord(paths.runtime.record, recordFor(2 ** 22 + 7919));
    assert.equal(await findEngine(paths), undefined);
    assert.equal(await readRuntimeRecord(paths.runtime.record), undefined);
    const record = recordFor(process.pid, address.port);
    await writeRuntimeRecord(paths.runtime.record, record);
    assert.equal(await findEngine(paths), undefined);
    assert.equal(await readRuntimeRecord(paths.runtime.record), undefined);
    await writeRuntimeRecord(paths.runtime.record, { ...record, bootId: "actual" });
    assert.equal((await findEngine(paths))?.record.bootId, "actual");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

for (const removeFirst of [true, false])
  test(`stop wait requires both PID exit and record removal (remove first: ${removeFirst})`, async () => {
    const home = await mkdtemp(join(tmpdir(), "eevee-wait-"));
    const paths = eeveePaths(home);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 250)"], { stdio: "ignore" });
    const exited = once(child, "exit");
    await once(child, "spawn");
    assert.ok(child.pid);
    const record = recordFor(child.pid);
    try {
      await writeRuntimeRecord(paths.runtime.record, record);
      let done = false;
      const waiting = waitForExit(paths, record, { timeoutMs: 3000, pollMs: 10 }).then(() => {
        done = true;
      });
      if (removeFirst) {
        await rm(paths.runtime.record);
        await sleep(30);
        assert.equal(done, false);
      } else {
        await exited;
        await sleep(30);
        assert.equal(done, false);
        await rm(paths.runtime.record);
      }
      await waiting;
      await exited;
      assert.equal(done, true);
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
      await rm(home, { recursive: true, force: true });
    }
  });

test("a shutdown acknowledgement is not success when the process stays alive", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-stop-timeout-"));
  const paths = eeveePaths(home);
  let requested = false;
  const server = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ bootId: "boot", version: "test" }));
    } else {
      assert.equal(req.url, "/api/engine/shutdown");
      assert.equal(req.method, "POST");
      assert.equal(req.headers["x-eevee-token"], "test-token");
      requested = true;
      res.writeHead(204).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await writeRuntimeRecord(paths.runtime.record, recordFor(process.pid, address.port));
    await assert.rejects(
      stopEngine(paths, { timeoutMs: 100 }),
      /Timed out.*waiting for the Engine.*exit/,
    );
    assert.equal(requested, true);
    assert.ok(await readRuntimeRecord(paths.runtime.record));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
  assert.equal(await stopEngine(paths), false);
});

test("a shutdown request that never answers has a bounded, explicit failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-request-timeout-"));
  const paths = eeveePaths(home);
  const server = createServer((req, res) => {
    if (req.url !== "/api/health") return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ bootId: "boot", version: "test" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await writeRuntimeRecord(paths.runtime.record, recordFor(process.pid, address.port));
    await assert.rejects(
      stopEngine(paths, { timeoutMs: 100 }),
      /Timed out requesting Engine shutdown/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("stop also waits when another stop has already closed the HTTP server", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-concurrent-stop-"));
  const paths = eeveePaths(home);
  const child = spawn(
    process.execPath,
    ["-e", "process.stdin.once('data', () => process.exit(0)); process.stdin.resume()"],
    {
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  const exited = once(child, "exit");
  await once(child, "spawn");
  assert.ok(child.pid);
  const server = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ bootId: "boot", version: "test" }));
    } else {
      res.writeHead(204).end();
      server.close();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const closed = once(server, "close");
  const stopping: Promise<boolean>[] = [];
  try {
    await writeRuntimeRecord(paths.runtime.record, recordFor(child.pid, address.port));
    stopping.push(stopEngine(paths));
    await closed;
    let secondDone = false;
    stopping.push(
      stopEngine(paths).then((result) => {
        secondDone = true;
        return result;
      }),
    );
    await sleep(30);
    assert.equal(secondDone, false);
    await rm(paths.runtime.record);
    child.stdin.end("exit");
    assert.deepEqual(await Promise.all(stopping), [true, true]);
  } finally {
    await rm(paths.runtime.record, { force: true });
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await Promise.allSettled(stopping);
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});
