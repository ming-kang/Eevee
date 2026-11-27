import { readFile, rm } from "node:fs/promises";
import { isEnoent, writeFileAtomic } from "@eevee/agent";

export type PidState = {
  readonly pid: number;
};

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

export async function readPidStateFile<T extends PidState>(
  filePath: string,
  guard: (value: unknown) => value is T,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writePidStateFile<T extends PidState>(filePath: string, state: T): Promise<void> {
  return writeJsonAtomic(filePath, state);
}

export async function removePidStateFile<T extends PidState>(
  filePath: string,
  guard: (value: unknown) => value is T,
  expectedPid?: number,
): Promise<void> {
  if (expectedPid !== undefined) {
    const current = await readPidStateFile(filePath, guard);
    if (current === undefined || current.pid !== expectedPid) return;
  }
  await rm(filePath, { force: true });
}
