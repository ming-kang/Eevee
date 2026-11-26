import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
import {
  isLegacyWslBashPath,
  type ResolveWindowsBashOptions,
  resolveWindowsBash,
} from "./discovery.ts";

const MOUNT_LINE = /^(.+?) on (\/.*) type \S+ \([^)]*\)$/;
const MOUNT_TIMEOUT_MS = 5000;
const DRIVE_MOUNT = /^\/([a-zA-Z])(?=\/|$)/;

export type Mount = {
  readonly point: string;
  readonly target: string;
};

export type MountLoaderOptions = ResolveWindowsBashOptions & {
  readonly shellArgs?: readonly string[];
  readonly readMounts?: () => Promise<readonly Mount[]>;
};

export function parseMounts(output: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = MOUNT_LINE.exec(line.trim());
    const source = match?.[1];
    const point = match?.[2];
    if (source === undefined || point === undefined) continue;
    if (!/^[a-z]:(?:[\\/]|$)/i.test(source)) continue;
    mounts.push({ point, target: win32.normalize(source.length === 2 ? `${source}\\` : source) });
  }
  return mounts.sort((a, b) => b.point.length - a.point.length);
}

export function toWindowsPath(path: string, mounts: readonly Mount[]): string | undefined {
  const normalized = posix.normalize(path);
  const mount = mounts.find(
    ({ point }) => point === "/" || normalized === point || normalized.startsWith(`${point}/`),
  );
  if (mount === undefined) return undefined;
  return win32.join(mount.target, posix.relative(mount.point, normalized));
}

export function rewriteDrivePath(path: string): string | undefined {
  const drive = DRIVE_MOUNT.exec(path)?.[1];
  if (drive === undefined) return undefined;
  const rest = path.slice(2).replace(/^\/+/, "");
  return rest === ""
    ? `${drive.toUpperCase()}:\\`
    : `${drive.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`;
}

export function rewriteMsysPath(path: string, mounts: readonly Mount[] = []): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  const normalized = posix.normalize(path);
  const specific = mounts.find(
    ({ point }) => point !== "/" && (normalized === point || normalized.startsWith(`${point}/`)),
  );
  if (specific !== undefined) {
    return win32.join(specific.target, posix.relative(specific.point, normalized));
  }
  const drive = rewriteDrivePath(path);
  if (drive !== undefined) return drive;
  const root = mounts.find(({ point }) => point === "/");
  if (root !== undefined) return win32.join(root.target, posix.relative("/", normalized));
  return path;
}

export function readMounts(shell: string, args: readonly string[] = ["-c"]): Promise<Mount[]> {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      [...args, "mount"],
      { timeout: MOUNT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseMounts(stdout));
      },
    );
  });
}

export function createMountLoader(
  options: MountLoaderOptions = {},
): () => Promise<readonly Mount[]> {
  let cached: Promise<readonly Mount[]> | undefined;
  const resolveAndReadMounts = async (): Promise<Mount[]> => {
    const env = options.env ?? process.env;
    const shell = await resolveWindowsBash({
      shellPath: options.shellPath,
      env,
      pathExists: options.pathExists,
      findOnPath: options.findOnPath,
    });
    if (shell === undefined) return [];
    // Legacy WSL mounts live in drvfs inside Linux rather than an MSYS mount table.
    if (isLegacyWslBashPath(shell, env.SystemRoot)) return [];
    return readMounts(shell, options.shellArgs ?? ["-c"]);
  };

  return async () => {
    if (options.readMounts !== undefined) return options.readMounts();
    if (cached === undefined) {
      const attempt = resolveAndReadMounts();
      cached = attempt;
      try {
        return await attempt;
      } catch {
        if (cached === attempt) cached = undefined;
        return [];
      }
    }
    try {
      return await cached;
    } catch {
      return [];
    }
  };
}
