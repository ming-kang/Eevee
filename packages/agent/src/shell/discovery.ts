import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { posix, win32 } from "node:path";

export const POWERSHELL_UTF8_PREAMBLE =
  "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

export const WINDOWS_POWERSHELL_EXIT_SUFFIX =
  '\n;\nif ($?) { exit 0 }\nif (($LASTEXITCODE -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }\nexit 1';

export const WINDOWS_POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
] as const;

export const POSIX_POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"] as const;

const WINDOWS_ROOT = /^[a-z]:[\\/]/i;
const LEGACY_WSL_BASH = /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i;
const GIT_NESTED_DIRS = new Set(["usr", "mingw64", "mingw32", "ucrt64", "clang64", "clangarm64"]);

export type BashShellConfig = {
  readonly shell: string;
  readonly args: readonly string[];
  readonly commandTransport: "argv" | "stdin";
  readonly isLegacyWsl: boolean;
};

export type ResolveWindowsBashOptions = {
  readonly shellPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly findOnPath?: () => Promise<string | undefined>;
};

export type ResolveBashShellOptions = ResolveWindowsBashOptions & {
  readonly platform?: NodeJS.Platform;
};

export type PowerShellKind = "pwsh" | "windows-powershell";

export type ResolvedPowerShell = {
  readonly executable: string;
  readonly kind: PowerShellKind;
  buildArgs(command: string): string[];
};

export type ResolvePowerShellOptions = {
  readonly shellPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly findOnPath?: (executable: string) => Promise<string | undefined>;
};

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    // Store execution aliases fail existsSync() stat checks on Windows; access(F_OK) succeeds.
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readPathEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env.PATH !== undefined) return env.PATH;
  if (env.Path !== undefined) return env.Path;
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "path" && value !== undefined) return value;
  }
  return undefined;
}

function splitWindowsPath(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = readPathEnv(env);
  if (raw === undefined || raw === "") return [];
  const separator =
    raw.includes(";") ||
    process.platform === "win32" ||
    /^[a-zA-Z]:[\\/]/.test(raw) ||
    raw.includes("\\")
      ? ";"
      : ":";
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const part of raw.split(separator)) {
    const cleaned = part.trim().replace(/^"+|"+$/g, "");
    if (cleaned === "") continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(cleaned);
  }
  return dirs;
}

function splitPosixPath(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = readPathEnv(env);
  if (raw === undefined || raw === "") return [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const part of raw.split(":")) {
    if (part === "" || seen.has(part)) continue;
    seen.add(part);
    dirs.push(part);
  }
  return dirs;
}

function shouldUsePosixPath(base: string, platform: NodeJS.Platform): boolean {
  return platform !== "win32" || (base.startsWith("/") && !base.startsWith("//"));
}

function joinDir(base: string, platform: NodeJS.Platform, ...parts: string[]): string {
  return shouldUsePosixPath(base, platform)
    ? posix.join(base, ...parts)
    : win32.join(base, ...parts);
}

function baseName(filePath: string, platform: NodeJS.Platform): string {
  return shouldUsePosixPath(filePath, platform)
    ? posix.basename(filePath)
    : win32.basename(filePath);
}

function dirName(filePath: string, platform: NodeJS.Platform): string {
  return shouldUsePosixPath(filePath, platform) ? posix.dirname(filePath) : win32.dirname(filePath);
}

function gitBashCandidates(gitDir: string): string[] {
  const parentName = baseName(dirName(gitDir, "win32"), "win32").toLowerCase();
  const list = GIT_NESTED_DIRS.has(parentName)
    ? [
        joinDir(gitDir, "win32", "..", "..", "bin", "bash.exe"),
        joinDir(gitDir, "win32", "..", "bin", "bash.exe"),
        joinDir(gitDir, "win32", "..", "usr", "bin", "bash.exe"),
        joinDir(gitDir, "win32", "bin", "bash.exe"),
        joinDir(gitDir, "win32", "usr", "bin", "bash.exe"),
        joinDir(gitDir, "win32", "..", "..", "usr", "bin", "bash.exe"),
      ]
    : [
        joinDir(gitDir, "win32", "..", "bin", "bash.exe"),
        joinDir(gitDir, "win32", "..", "usr", "bin", "bash.exe"),
        joinDir(gitDir, "win32", "bin", "bash.exe"),
        joinDir(gitDir, "win32", "usr", "bin", "bash.exe"),
        joinDir(gitDir, "win32", "..", "..", "bin", "bash.exe"),
        joinDir(gitDir, "win32", "..", "..", "usr", "bin", "bash.exe"),
      ];
  return [...new Set(list)];
}

async function findExecutableInDirs(
  dirs: readonly string[],
  executable: string,
  platform: NodeJS.Platform,
  pathExists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const dir of dirs) {
    const candidate = joinDir(dir, platform, executable);
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

export function isLegacyWslBashPath(shellPath: string, systemRoot?: string): boolean {
  const normalized = win32.normalize(shellPath).toLowerCase();
  if (win32.basename(normalized) === "wsl.exe") return true;
  if (systemRoot !== undefined && systemRoot !== "" && WINDOWS_ROOT.test(systemRoot)) {
    return ["System32", "Sysnative"].some(
      (directory) => normalized === win32.join(systemRoot, directory, "bash.exe").toLowerCase(),
    );
  }
  return LEGACY_WSL_BASH.test(normalized);
}

export async function resolveWindowsBash(
  options: ResolveWindowsBashOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? defaultPathExists;

  if (options.shellPath !== undefined) {
    return (await pathExists(options.shellPath)) ? options.shellPath : undefined;
  }

  const pathDirs = splitWindowsPath(env);
  for (const dir of pathDirs) {
    if (!(await pathExists(joinDir(dir, "win32", "git.exe")))) continue;
    for (const candidate of gitBashCandidates(dir)) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  const programFiles = env.ProgramFiles;
  if (programFiles) {
    const candidate = joinDir(programFiles, "win32", "Git", "bin", "bash.exe");
    if (await pathExists(candidate)) return candidate;
  }
  const programFilesX86 = env["ProgramFiles(x86)"];
  if (programFilesX86) {
    const candidate = joinDir(programFilesX86, "win32", "Git", "bin", "bash.exe");
    if (await pathExists(candidate)) return candidate;
  }

  if (options.findOnPath !== undefined) {
    return options.findOnPath();
  }

  let legacyWslFallback: string | undefined;
  for (const dir of pathDirs) {
    const candidate = joinDir(dir, "win32", "bash.exe");
    if (!(await pathExists(candidate))) continue;
    if (!isLegacyWslBashPath(candidate, env.SystemRoot)) return candidate;
    legacyWslFallback ??= candidate;
  }
  return legacyWslFallback;
}

export async function resolveBashShell(
  options: ResolveBashShellOptions = {},
): Promise<BashShellConfig | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? defaultPathExists;

  if (platform === "win32") {
    const shell = await resolveWindowsBash(options);
    if (shell === undefined) return undefined;
    const isLegacyWsl = isLegacyWslBashPath(shell, env.SystemRoot);
    return {
      shell,
      args: isLegacyWsl ? ["-s"] : ["-c"],
      commandTransport: isLegacyWsl ? "stdin" : "argv",
      isLegacyWsl,
    };
  }

  if (options.shellPath !== undefined) {
    return (await pathExists(options.shellPath))
      ? { shell: options.shellPath, args: ["-c"], commandTransport: "argv", isLegacyWsl: false }
      : undefined;
  }

  if (await pathExists("/bin/bash")) {
    return { shell: "/bin/bash", args: ["-c"], commandTransport: "argv", isLegacyWsl: false };
  }

  const pathDirs = splitPosixPath(env);
  const bashOnPath =
    options.findOnPath !== undefined
      ? await options.findOnPath()
      : await findExecutableInDirs(pathDirs, "bash", platform, pathExists);
  if (bashOnPath !== undefined) {
    return { shell: bashOnPath, args: ["-c"], commandTransport: "argv", isLegacyWsl: false };
  }

  if (await pathExists("/bin/sh")) {
    return { shell: "/bin/sh", args: ["-c"], commandTransport: "argv", isLegacyWsl: false };
  }

  const shOnPath = await findExecutableInDirs(pathDirs, "sh", platform, pathExists);
  if (shOnPath !== undefined) {
    return { shell: shOnPath, args: ["-c"], commandTransport: "argv", isLegacyWsl: false };
  }

  return undefined;
}

function classifyPowerShell(executable: string, platform: NodeJS.Platform): PowerShellKind {
  return baseName(executable, platform).toLowerCase() === "powershell.exe"
    ? "windows-powershell"
    : "pwsh";
}

function buildResolvedPowerShell(
  executable: string,
  kind: PowerShellKind,
  platform: NodeJS.Platform,
): ResolvedPowerShell {
  const baseArgs = platform === "win32" ? WINDOWS_POWERSHELL_ARGS : POSIX_POWERSHELL_ARGS;
  return {
    executable,
    kind,
    buildArgs: (command: string) => {
      // A trailing backtick would continue the user's last line into the exit suffix.
      const suffix =
        kind === "windows-powershell" && !command.endsWith("`")
          ? WINDOWS_POWERSHELL_EXIT_SUFFIX
          : "";
      return [...baseArgs, `${POWERSHELL_UTF8_PREAMBLE}${command}${suffix}`];
    },
  };
}

export async function resolvePowerShell(
  options: ResolvePowerShellOptions = {},
): Promise<ResolvedPowerShell | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? defaultPathExists;

  if (options.shellPath !== undefined) {
    if (!(await pathExists(options.shellPath))) return undefined;
    return buildResolvedPowerShell(
      options.shellPath,
      classifyPowerShell(options.shellPath, platform),
      platform,
    );
  }

  if (platform === "win32") {
    const pathDirs = splitWindowsPath(env);
    const pwshOnPath =
      options.findOnPath !== undefined
        ? await options.findOnPath("pwsh.exe")
        : await findExecutableInDirs(pathDirs, "pwsh.exe", "win32", pathExists);
    if (pwshOnPath !== undefined) {
      return buildResolvedPowerShell(pwshOnPath, "pwsh", platform);
    }

    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      const candidate = joinDir(root, "win32", "PowerShell", "7", "pwsh.exe");
      if (await pathExists(candidate)) {
        return buildResolvedPowerShell(candidate, "pwsh", platform);
      }
    }

    const powershellOnPath =
      options.findOnPath !== undefined
        ? await options.findOnPath("powershell.exe")
        : await findExecutableInDirs(pathDirs, "powershell.exe", "win32", pathExists);
    if (powershellOnPath !== undefined) {
      return buildResolvedPowerShell(powershellOnPath, "windows-powershell", platform);
    }

    const systemRoot = env.SystemRoot ?? (options.env === undefined ? "C:\\Windows" : undefined);
    if (systemRoot) {
      const candidate = joinDir(
        systemRoot,
        "win32",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      if (await pathExists(candidate)) {
        return buildResolvedPowerShell(candidate, "windows-powershell", platform);
      }
    }
    return undefined;
  }

  const pathDirs = splitPosixPath(env);
  const pwshOnPath =
    options.findOnPath !== undefined
      ? await options.findOnPath("pwsh")
      : await findExecutableInDirs(pathDirs, "pwsh", platform, pathExists);
  if (pwshOnPath !== undefined) {
    return buildResolvedPowerShell(pwshOnPath, "pwsh", platform);
  }

  if (options.env === undefined) {
    for (const candidate of ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh"]) {
      if (await pathExists(candidate)) {
        return buildResolvedPowerShell(candidate, "pwsh", platform);
      }
    }
  }

  return undefined;
}
