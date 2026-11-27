import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode } from "@eevee/agent";

export type ProcessLock = {
  readonly pid: number;
  release(): Promise<void>;
};

type LockOwner = {
  readonly pid: number;
  readonly token: string;
};

function isRetryableLockError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "EEXIST") return true;
  if (process.platform === "win32" && code === "EPERM") return true;
  return false;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function readOwner(lockFile: string): Promise<LockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.pid !== "number" ||
      !Number.isInteger(candidate.pid) ||
      candidate.pid <= 0 ||
      typeof candidate.token !== "string"
    ) {
      return undefined;
    }
    return { pid: candidate.pid, token: candidate.token };
  } catch {
    return undefined;
  }
}

function isFreshLiveOwner(
  current: LockOwner | undefined,
  mtimeMs: number | undefined,
  staleMs: number,
): boolean {
  return (
    current !== undefined &&
    mtimeMs !== undefined &&
    isProcessAlive(current.pid) &&
    Date.now() - mtimeMs < staleMs
  );
}

async function tryLinkLock(lockFile: string, owner: LockOwner): Promise<boolean> {
  const tempFile = `${lockFile}.${process.pid}.${owner.token}.tmp`;
  try {
    await writeFile(tempFile, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await link(tempFile, lockFile);
    return true;
  } catch (error) {
    if (isRetryableLockError(error)) return false;
    throw error;
  } finally {
    await rm(tempFile, { force: true }).catch(() => undefined);
  }
}

async function tryRecoverAndAcquire(
  lockFile: string,
  owner: LockOwner,
  staleMs: number,
): Promise<"acquired" | "busy" | "contended"> {
  const recoverFile = `${lockFile}.recover`;
  try {
    await writeFile(recoverFile, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (!isRetryableLockError(error)) throw error;
    const recoverOwner = await readOwner(recoverFile);
    const recoverInfo = await stat(recoverFile).catch(() => undefined);
    const recoverStaleMs = Math.min(staleMs, 5_000);
    if (
      recoverInfo !== undefined &&
      !isFreshLiveOwner(recoverOwner, recoverInfo.mtimeMs, recoverStaleMs)
    ) {
      const staleRecover = `${recoverFile}.${process.pid}.${owner.token}.stale`;
      await rename(recoverFile, staleRecover).catch(() => undefined);
      await rm(staleRecover, { force: true }).catch(() => undefined);
    }
    return "contended";
  }

  try {
    const current = await readOwner(lockFile);
    const info = await stat(lockFile).catch(() => undefined);
    if (info !== undefined) {
      if (isFreshLiveOwner(current, info.mtimeMs, staleMs)) {
        return "busy";
      }
      const staleFile = `${lockFile}.${process.pid}.${owner.token}.stale`;
      try {
        await rename(lockFile, staleFile);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          if (isRetryableLockError(error) || errorCode(error) === "EBUSY") return "contended";
          throw error;
        }
      }
      await rm(staleFile, { force: true }).catch(() => undefined);
    }
    return (await tryLinkLock(lockFile, owner)) ? "acquired" : "contended";
  } finally {
    const currentRecover = await readOwner(recoverFile);
    if (currentRecover?.token === owner.token) {
      await rm(recoverFile, { force: true }).catch(() => undefined);
    }
  }
}

function createLockHandle(lockFile: string, owner: LockOwner, heartbeatMs: number): ProcessLock {
  let released = false;
  const heartbeat = setInterval(() => {
    void utimes(lockFile, new Date(), new Date()).catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref?.();
  return {
    pid: process.pid,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      const current = await readOwner(lockFile);
      if (current?.token === owner.token) await rm(lockFile, { force: true });
    },
  };
}

export async function acquireProcessLock(
  lockFile: string,
  options: {
    readonly timeoutMs?: number;
    readonly heartbeatMs?: number;
    readonly staleMs?: number;
  } = {},
): Promise<ProcessLock> {
  await mkdir(dirname(lockFile), { recursive: true });
  const deadline = Date.now() + (options.timeoutMs ?? 0);
  const heartbeatMs = options.heartbeatMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const owner: LockOwner = { pid: process.pid, token: randomBytes(16).toString("hex") };
  let recoveryDeadline: number | undefined;

  for (;;) {
    if (await tryLinkLock(lockFile, owner)) {
      return createLockHandle(lockFile, owner, heartbeatMs);
    }

    const current = await readOwner(lockFile);
    const info = await stat(lockFile).catch(() => undefined);
    if (info === undefined) {
      continue;
    }
    if (current !== undefined && isFreshLiveOwner(current, info.mtimeMs, staleMs)) {
      if (Date.now() >= deadline) {
        throw new Error(`Process ${current.pid} holds lock ${lockFile}`);
      }
      await delay(25);
      continue;
    }

    const outcome = await tryRecoverAndAcquire(lockFile, owner, staleMs);
    if (outcome === "acquired") {
      return createLockHandle(lockFile, owner, heartbeatMs);
    }
    if (outcome === "busy") {
      const liveOwner = await readOwner(lockFile);
      if (Date.now() >= deadline) {
        throw new Error(
          `Process ${liveOwner?.pid ?? current?.pid ?? "unknown"} holds lock ${lockFile}`,
        );
      }
      await delay(25);
      continue;
    }

    const now = Date.now();
    recoveryDeadline ??= Math.max(deadline, now + 1_000);
    if (now >= recoveryDeadline) {
      const liveOwner = await readOwner(lockFile);
      if (liveOwner !== undefined && isProcessAlive(liveOwner.pid)) {
        throw new Error(`Process ${liveOwner.pid} holds lock ${lockFile}`);
      }
      throw new Error(`Timed out recovering lock ${lockFile}`);
    }
    await delay(10);
  }
}
