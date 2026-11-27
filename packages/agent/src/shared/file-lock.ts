import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode } from "./guards.ts";

const RETRY_DELAY_MS = 25;
const MAX_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

const inProcessQueues = new Map<string, Promise<unknown>>();

function isRetryableLockError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "EEXIST") return true;
  // Windows may keep a freshly removed lock directory delete-pending briefly.
  if (code === "EPERM" && process.platform === "win32") return true;
  return false;
}

async function acquireLockDir(lockPath: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    signal?.throwIfAborted();
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if (!isRetryableLockError(error)) throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      await delay(RETRY_DELAY_MS, undefined, { signal });
    }
  }
}

async function waitForPrevious(previous: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await previous;
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
    );
  });
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const lockPath = `${filePath}.lock`;
  const previous = inProcessQueues.get(filePath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const chained = previous.then(() => current);
  inProcessQueues.set(filePath, chained);

  try {
    await waitForPrevious(previous, signal);
    await acquireLockDir(lockPath, signal);
    try {
      return await fn();
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    releaseQueue();
    // Defer map cleanup until `chained` settles so an aborted waiter cannot drop an active predecessor's queue tail.
    void chained.then(() => {
      if (inProcessQueues.get(filePath) === chained) {
        inProcessQueues.delete(filePath);
      }
    });
  }
}

export async function writeFileAtomic(
  filePath: string,
  content: string,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(
    tempPath,
    content,
    mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode },
  );
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
