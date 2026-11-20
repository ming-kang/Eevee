import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProblemError } from "../domain/index.ts";
import type { DirEntry, DirListing } from "../protocol/contract.ts";

/**
 * Directory listings for the panel's path picker; a browser cannot hand back an absolute path, so the Engine
 * lists the directories instead. An empty `path` is the roots: the drive letters on Windows, `/` elsewhere.
 */
export async function browseDirs(path: string | undefined): Promise<DirListing> {
  if (path === undefined || path === "") return { path: "", home: homedir(), dirs: await roots() };
  const resolved = resolve(path);
  const entries = await readdir(resolved, { withFileTypes: true }).catch((error) => {
    throw dirProblem(error, resolved);
  });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry): DirEntry => ({ name: entry.name, path: join(resolved, entry.name) }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
    );
  const up = parent(resolved);
  return { path: resolved, ...(up === undefined ? {} : { parent: up }), dirs };
}

function parent(dir: string): string | undefined {
  const up = dirname(dir);
  if (up !== dir) return up;
  // A drive root's parent is the roots pseudo-view; the filesystem root has none.
  return process.platform === "win32" ? "" : undefined;
}

// Drive letters that do not answer within this window are skipped, so a dead network or
// removable drive does not stall the picker.
const DRIVE_PROBE_MS = 300;

async function roots(): Promise<DirEntry[]> {
  if (process.platform !== "win32") return [{ name: "/", path: "/" }];
  const drives = await Promise.all(
    Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).map((drive) =>
      Promise.race([
        stat(drive).then(
          (info) => (info.isDirectory() ? drive : undefined),
          () => undefined,
        ),
        delay(DRIVE_PROBE_MS).then(() => undefined),
      ]),
    ),
  );
  return drives.flatMap((drive) => (drive === undefined ? [] : [{ name: drive, path: drive }]));
}

function dirProblem(error: unknown, path: string): ProblemError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOTDIR") return new ProblemError({ code: "not_dir", path });
  return new ProblemError({ code: "no_dir", path });
}
