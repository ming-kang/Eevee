import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

export const SHELL_PATHS_EXTENSION = "eevee.shell-paths";

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);
const MOUNT_LINE = /^(.+?) on (\/.*) type \S+ \([^)]*\)$/;
const MOUNT_TIMEOUT_MS = 5000;
const WHERE_TIMEOUT_MS = 5000;
const DRIVE_MOUNT = /^\/([a-zA-Z])(?=\/|$)/;
const WINDOWS_ROOT = /^[a-z]:[\\/]/i;
const LEGACY_WSL_BASH = /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i;

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

export function isLegacyWslBashPath(shellPath: string, systemRoot?: string): boolean {
  const normalized = win32.normalize(shellPath).toLowerCase();
  if (win32.basename(normalized) === "wsl.exe") return true;
  if (systemRoot !== undefined && systemRoot !== "" && WINDOWS_ROOT.test(systemRoot)) {
    return ["System32", "Sysnative"].some(
      (directory) => normalized === win32.join(systemRoot, directory, "bash.exe").toLowerCase(),
    );
  }
  // Without a known Windows directory only the conventional launcher paths can be told apart.
  return LEGACY_WSL_BASH.test(normalized);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function whereFirstLine(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "where",
      ["bash.exe"],
      { timeout: WHERE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const first = stdout.trim().split(/\r?\n/)[0]?.trim();
        resolve(first === undefined || first === "" ? undefined : first);
      },
    );
  });
}

export type ResolveWindowsBashOptions = {
  readonly shellPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly findOnPath?: () => Promise<string | undefined>;
};

export async function resolveWindowsBash(
  options: ResolveWindowsBashOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? fileExists;
  const findOnPath =
    options.findOnPath ??
    (async () => {
      const first = await whereFirstLine();
      if (first === undefined) return undefined;
      return (await pathExists(first)) ? first : undefined;
    });
  if (options.shellPath !== undefined) {
    return (await pathExists(options.shellPath)) ? options.shellPath : undefined;
  }
  const programFiles = env.ProgramFiles;
  if (programFiles) {
    const candidate = `${programFiles}\\Git\\bin\\bash.exe`;
    if (await pathExists(candidate)) return candidate;
  }
  const programFilesX86 = env["ProgramFiles(x86)"];
  if (programFilesX86) {
    const candidate = `${programFilesX86}\\Git\\bin\\bash.exe`;
    if (await pathExists(candidate)) return candidate;
  }
  return findOnPath();
}

export type ShellPathsOptions = {
  readonly shellPath?: string;
  readonly shellArgs?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly readMounts?: () => Promise<readonly Mount[]>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly findOnPath?: () => Promise<string | undefined>;
};

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
  const resolveAndReadMounts = async (): Promise<Mount[]> => {
    const shell = await resolveWindowsBash({
      shellPath: options.shellPath,
      env: options.env,
      pathExists: options.pathExists,
      findOnPath: options.findOnPath,
    });
    if (shell === undefined) return [];
    // WSL mounts are drvfs, not the MSYS drive layout this extension rewrites, so there is no
    // usable mount table behind a legacy WSL launcher.
    if (isLegacyWslBashPath(shell, (options.env ?? process.env).SystemRoot)) return [];
    return readMounts(shell, options.shellArgs ?? ["-c"]);
  };
  const loadMounts = async (): Promise<readonly Mount[]> => {
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

  return defineExtension({
    name: SHELL_PATHS_EXTENSION,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          const platform = options.platform ?? process.platform;
          if (platform !== "win32") return undefined;
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
