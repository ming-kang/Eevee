import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type FileHandle,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { isNotFound, readJson, writeJsonAtomic } from "../shared/fs.ts";

export type RuntimeRecord = {
  pid: number;
  port: number;
  bootId: string;
  version: string;
  startedAt: number;
  token: string;
};

export class InstanceLocked extends Error {
  override name = "InstanceLocked";
}

type LockOwner = { pid: number; host?: string; token?: string };

const ATTEMPTS = 8;
const UNSUPPORTED_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS", "EXDEV"]);

export async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const token = randomBytes(12).toString("hex");
  const body = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    host: hostname(),
    token,
  });
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (await claim(path, body)) {
      const held = await readOwner(path);
      if (held?.token === token) return () => release(path, token);
      continue;
    }
    const owner = await readOwner(path);
    if (owner !== undefined && holdsLock(owner)) {
      throw new InstanceLocked(`The Engine is already running (pid ${owner.pid})`);
    }
    await retire(path);
  }
  throw new InstanceLocked("Could not acquire the Engine's lock");
}

/**
 * Publishes `body` at `path` without ever leaving a partial lock visible: the content is written under a private
 * name first and the lock name is made to point at it atomically.
 */
async function claim(path: string, body: string): Promise<boolean> {
  const staged = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(staged, body, { mode: 0o600 });
    try {
      await link(staged, path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code === undefined || !UNSUPPORTED_LINK.has(code)) throw error;
      return claimExclusive(path, body);
    }
  } finally {
    await rm(staged, { force: true });
  }
}

/** The fallback for file systems without hard links; the caller verifies ownership by the token. */
async function claimExclusive(path: string, body: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/** Moves a lock aside under a unique name, so at most one process reclaims the same stale lock. */
async function retire(path: string): Promise<void> {
  const tomb = `${path}.stale.${randomBytes(6).toString("hex")}`;
  try {
    await rename(path, tomb);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await rm(tomb, { force: true });
}

async function release(path: string, token: string): Promise<void> {
  if ((await readOwner(path))?.token !== token) return;
  await rm(path, { force: true });
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const held = JSON.parse(text) as Partial<LockOwner>;
    if (typeof held.pid === "number" && Number.isInteger(held.pid) && held.pid > 0) {
      return held as LockOwner;
    }
    return undefined;
  } catch {
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? { pid } : undefined;
  }
}

function holdsLock(owner: LockOwner): boolean {
  if (owner.host !== undefined && owner.host !== hostname()) return true;
  return isAlive(owner.pid);
}

export async function isInstanceLocked(path: string): Promise<boolean> {
  const owner = await readOwner(path);
  return owner !== undefined && holdsLock(owner);
}

export async function readRuntimeRecord(path: string): Promise<RuntimeRecord | undefined> {
  let record: Partial<RuntimeRecord> | undefined;
  try {
    record = await readJson<Partial<RuntimeRecord>>(path);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (
    record === undefined ||
    record === null ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid ?? 0) <= 0 ||
    !Number.isInteger(record.port) ||
    (record.port ?? 0) < 1 ||
    (record.port ?? 0) > 65535 ||
    typeof record.bootId !== "string" ||
    !record.bootId ||
    typeof record.version !== "string" ||
    !record.version ||
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt) ||
    typeof record.token !== "string" ||
    !record.token
  )
    return undefined;
  return record as RuntimeRecord;
}

export async function removeRuntimeRecord(path: string, owner: RuntimeRecord): Promise<void> {
  const current = await readRuntimeRecord(path);
  if (
    current?.bootId === owner.bootId &&
    current.pid === owner.pid &&
    current.token === owner.token
  )
    await rm(path, { force: true });
}

export const writeRuntimeRecord = (path: string, record: RuntimeRecord) =>
  writeJsonAtomic(path, record, process.platform === "win32" ? {} : { mode: 0o600 });

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A zombie has exited, but kill(pid, 0) succeeds until its parent reaps it.
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
      } catch (error) {
        if (isNotFound(error)) return false;
      }
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
