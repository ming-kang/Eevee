export {
  type BashShellConfig,
  isLegacyWslBashPath,
  POSIX_POWERSHELL_ARGS,
  POWERSHELL_UTF8_PREAMBLE,
  type PowerShellKind,
  type ResolveBashShellOptions,
  type ResolvedPowerShell,
  type ResolvePowerShellOptions,
  type ResolveWindowsBashOptions,
  resolveBashShell,
  resolvePowerShell,
  resolveWindowsBash,
  WINDOWS_POWERSHELL_ARGS,
  WINDOWS_POWERSHELL_EXIT_SUFFIX,
} from "./discovery.ts";
export { createManagedExecutionEnv, type ManagedExecutionEnvOptions } from "./env.ts";
export {
  createMountLoader,
  type Mount,
  type MountLoaderOptions,
  parseMounts,
  readMounts,
  rewriteDrivePath,
  rewriteMsysPath,
  toWindowsPath,
} from "./mounts.ts";
export { type NormalizeCommandResult, normalizePosixBashCommand } from "./normalize.ts";
export {
  type KillProcessTreeOptions,
  killProcessTree,
  type WaitForChildProcessOptions,
  waitForChildProcess,
} from "./process.ts";
