import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type ProcessLock = {
  readonly pid: number;
  release(): Promise<void>;
};

type LockOwner = {
  readonly pid: number;
  readonly token: string;
};

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
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

  for (;;) {
    const tempFile = `${lockFile}.${process.pid}.${owner.token}.tmp`;
    let acquired = false;
    try {
      await writeFile(tempFile, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await link(tempFile, lockFile);
      acquired = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    } finally {
      await rm(tempFile, { force: true }).catch(() => undefined);
    }

    if (acquired) {
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

    const current = await readOwner(lockFile);
    const info = await stat(lockFile).catch(() => undefined);
    const fresh = info !== undefined && Date.now() - info.mtimeMs < staleMs;
    if (current !== undefined && isProcessAlive(current.pid) && fresh) {
      if (Date.now() >= deadline) {
        throw new Error(`Process ${current.pid} holds lock ${lockFile}`);
      }
      await delay(25);
      continue;
    }

    const staleFile = `${lockFile}.${process.pid}.${owner.token}.stale`;
    try {
      await rename(lockFile, staleFile);
      await rm(staleFile, { force: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        if (Date.now() >= deadline) throw error;
        await delay(25);
      }
    }
  }
}
