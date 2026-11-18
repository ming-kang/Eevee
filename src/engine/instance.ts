import { randomBytes } from "node:crypto";
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
  startedAt: number;
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
      throw new InstanceLocked(`Eevee is already running (pid ${owner.pid})`);
    }
    await retire(path);
  }
  throw new InstanceLocked("Could not acquire the instance lock");
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

export const readRuntimeRecord = (path: string) => readJson<RuntimeRecord>(path);

export const writeRuntimeRecord = (path: string, record: RuntimeRecord) =>
  writeJsonAtomic(path, record, { mode: 0o600 });

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
