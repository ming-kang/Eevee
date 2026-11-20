import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  InstanceLocked,
  isAlive,
  type RuntimeRecord,
  readRuntimeRecord,
  removeRuntimeRecord,
} from "../daemon/instance.ts";
import { runEngine } from "../daemon/main.ts";
import { createClient } from "../protocol/client.ts";
import { engineEntry } from "../shared/package.ts";
import type { EeveePaths } from "../shared/paths.ts";
import { type Connection, findEngine } from "./connection.ts";

export async function startEngine(
  paths: EeveePaths,
  options: { foreground?: boolean } = {},
): Promise<{ connection: Connection; started: boolean } | undefined> {
  const running = await findEngine(paths);
  if (running) return { connection: running, started: false };
  if (options.foreground) {
    try {
      await runEngine(paths);
      return undefined;
    } catch (error) {
      if (!(error instanceof InstanceLocked)) throw error;
    }
  }
  await mkdir(paths.runtime.dir, { recursive: true });
  const logPath = join(paths.runtime.dir, "engine.log");
  let exited = false;
  if (!options.foreground) {
    const log = await open(logPath, "a");
    try {
      const child = spawn(process.execPath, [engineEntry], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, EEVEE_HOME: paths.home },
      });
      child.once("exit", () => {
        exited = true;
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
  }
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const connection = await findEngine(paths);
    if (connection) return { connection, started: !options.foreground };
    if (exited) throw new Error(`The Engine exited before becoming ready. See the log: ${logPath}`);
  }
  throw new Error(`Timed out waiting for the Engine to start. See the log: ${logPath}`);
}

export async function waitForExit(
  paths: EeveePaths,
  record: RuntimeRecord,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const current = await readRuntimeRecord(paths.runtime.record);
    const ownsRecord = current?.pid === record.pid && current.bootId === record.bootId;
    if (!isAlive(record.pid) && !ownsRecord) return;
    if (performance.now() >= deadline)
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the Engine (pid ${record.pid}) to exit and remove its runtime record.`,
      );
    await sleep(Math.min(options.pollMs ?? 100, Math.max(1, deadline - performance.now())));
  }
}

export async function stopEngine(
  paths: EeveePaths,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const running = await findEngine(paths);
  if (!running) {
    const record = await readRuntimeRecord(paths.runtime.record);
    if (record === undefined) return false;
    if (!isAlive(record.pid)) {
      await removeRuntimeRecord(paths.runtime.record, record);
      return false;
    }
    await waitForExit(paths, record, options);
    return true;
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = performance.now() + timeoutMs;
  try {
    await createClient({
      baseUrl: running.baseUrl,
      token: running.record.token,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    }).call("POST /api/engine/shutdown");
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new Error(`Timed out requesting Engine shutdown (pid ${running.record.pid}).`, {
        cause: error,
      });
    throw error;
  }
  await waitForExit(paths, running.record, {
    timeoutMs: Math.max(0, deadline - performance.now()),
  });
  return true;
}
