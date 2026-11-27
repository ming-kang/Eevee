import { type ChildProcess, spawn } from "node:child_process";
import { win32 } from "node:path";
import { errorCode } from "../shared/guards.ts";

const DEFAULT_EXIT_STDIO_GRACE_MS = 100;
const DEFAULT_MAX_STDIO_GRACE_MS = 2000;

export type KillProcessTreeOptions = {
  readonly signal?: NodeJS.Signals;
  readonly forceAfterMs?: number;
  readonly platform?: NodeJS.Platform;
};

export type WaitForChildProcessOptions = {
  readonly graceMs?: number;
  readonly maxGraceMs?: number;
  readonly isDraining?: () => boolean;
};

function tryKill(targetPid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(targetPid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalPosixProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  useDarwinStopGuard: boolean,
): void {
  const needsContinue =
    useDarwinStopGuard && signal !== "SIGKILL" && signal !== "SIGSTOP" && signal !== "SIGCONT";
  let stoppedGroup = false;
  if (needsContinue) {
    // macOS signals group members sequentially; stopping the group first prevents a shell from
    // launching the next chained command before receiving the termination signal.
    stoppedGroup = tryKill(-pid, "SIGSTOP");
  } else if (useDarwinStopGuard && signal === "SIGKILL") {
    tryKill(-pid, "SIGSTOP");
  }

  let killedGroup = false;
  try {
    process.kill(-pid, signal);
    killedGroup = true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH" || code === "EPERM") {
      tryKill(pid, signal);
    }
  }

  if (stoppedGroup) {
    tryKill(-pid, "SIGCONT");
    if (!killedGroup) {
      tryKill(pid, "SIGCONT");
    }
  }
}

function getTaskkillPath(): string {
  return win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
}

export function killProcessTree(pid: number, options: KillProcessTreeOptions = {}): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    try {
      const child = spawn(getTaskkillPath(), ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.once("error", () => {});
    } catch {
      // Ignore spawn failures or processes that already exited.
    }
    return;
  }

  const signal = options.signal ?? "SIGTERM";
  const isDarwin = platform === "darwin";
  signalPosixProcessTree(pid, signal, isDarwin);

  if (
    options.forceAfterMs !== undefined &&
    Number.isFinite(options.forceAfterMs) &&
    options.forceAfterMs >= 0 &&
    signal !== "SIGKILL"
  ) {
    const timer = setTimeout(() => {
      signalPosixProcessTree(pid, "SIGKILL", isDarwin);
    }, options.forceAfterMs);
    timer.unref?.();
  }
}

export function waitForChildProcess(
  child: ChildProcess,
  options: WaitForChildProcessOptions = {},
): Promise<number | null> {
  const graceMs = Math.max(0, options.graceMs ?? DEFAULT_EXIT_STDIO_GRACE_MS);
  const maxGraceMs = options.maxGraceMs ?? DEFAULT_MAX_STDIO_GRACE_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let maxGraceTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null || child.stdout.readableEnded;
    let stderrEnded = child.stderr === null || child.stderr.readableEnded;

    const cleanup = () => {
      if (postExitTimer !== undefined) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      if (maxGraceTimer !== undefined) {
        clearTimeout(maxGraceTimer);
        maxGraceTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) {
        finalize(exitCode);
      }
    };

    const armIdleTimer = () => {
      if (postExitTimer !== undefined) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => {
        if (options.isDraining?.()) armIdleTimer();
        else finalize(exitCode);
      }, graceMs);
    };

    const armMaxGraceTimer = () => {
      if (maxGraceTimer !== undefined || !Number.isFinite(maxGraceMs)) return;
      maxGraceTimer = setTimeout(
        () => {
          finalize(exitCode);
        },
        Math.max(0, maxGraceMs),
      );
    };

    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) {
        armIdleTimer();
        armMaxGraceTimer();
      }
    };

    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);

    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode);
    }
  });
}
