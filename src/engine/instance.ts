import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { readJson, writeJsonAtomic } from "../shared/fs.ts";

export type RuntimeRecord = {
  pid: number;
  port: number;
  bootId: string;
  startedAt: number;
};

export class InstanceLocked extends Error {
  override name = "InstanceLocked";
}

export async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
        throw new InstanceLocked(`Eevee 已经在运行（pid ${owner}）`);
      }
      await rm(path, { force: true });
    }
  }
  throw new InstanceLocked("无法获取实例锁");
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
