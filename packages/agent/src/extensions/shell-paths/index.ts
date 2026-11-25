import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

export const SHELL_PATHS_EXTENSION = "eevee.shell-paths";

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);
const MOUNT_LINE = /^(.+?) on (\/.*) type \S+ \([^)]*\)$/;
const MOUNT_TIMEOUT_MS = 5000;
const DRIVE_MOUNT = /^\/([a-zA-Z])(?=\/|$)/;

export type Mount = {
  readonly point: string;
  readonly target: string;
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

function readMounts(shell: string, args: readonly string[]): Promise<Mount[]> {
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

export type ShellPathsOptions = {
  readonly shellPath?: string;
  readonly shellArgs?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly readMounts?: () => Promise<readonly Mount[]>;
};

function isWslShell(shellPath: string | undefined): boolean {
  if (shellPath === undefined) return false;
  const name = shellPath.toLowerCase();
  return name.endsWith("wsl.exe") || name.includes("system32\\bash");
}

export function rewriteToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  mounts: readonly Mount[],
): Record<string, unknown> | undefined {
  if (!PATH_TOOLS.has(toolName)) return undefined;
  const path = args.path;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return undefined;
  const rewritten = rewriteMsysPath(path, mounts);
  if (rewritten === path) return undefined;
  return { ...args, path: rewritten };
}

export function createShellPathsExtension(options: ShellPathsOptions = {}) {
  let cached: Promise<Mount[]> | undefined;
  const loadMounts = async (): Promise<readonly Mount[]> => {
    if (options.readMounts !== undefined) return options.readMounts();
    if (cached === undefined) {
      const attempt = readMounts(options.shellPath ?? "bash.exe", options.shellArgs ?? ["-c"]);
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

  return defineExtension({
    name: SHELL_PATHS_EXTENSION,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          const platform = options.platform ?? process.platform;
          if (platform !== "win32") return undefined;
          if (isWslShell(options.shellPath)) return undefined;
          const args = call.arguments as Record<string, unknown>;
          const mounts = await loadMounts();
          const rewritten = rewriteToolArguments(call.name, args, mounts);
          if (rewritten === undefined) return undefined;
          return { arguments: rewritten as never };
        },
      }),
    ],
  });
}
