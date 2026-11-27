import { type ChildProcess, spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { removeEngineState } from "./auth.ts";
import {
  isSupervisorStopRequested,
  readSupervisorState,
  removeSupervisorState,
  type SupervisorRuntimeState,
  writeSupervisorState,
} from "./daemon.ts";
import { dataDirLayout, resolveDataDir } from "./data-dir.ts";
import { acquireProcessLock } from "./process-lock.ts";
import { DEFAULT_ENGINE_PORT } from "./server.ts";

export type RunSupervisorOptions = {
  readonly dataDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cliEntry: string;
  readonly port?: number;
  readonly restartDelayMs?: number;
  readonly shutdownTimeoutMs?: number;
};

export async function runSupervisor(options: RunSupervisorOptions): Promise<void> {
  const layout = dataDirLayout(options.dataDir ?? resolveDataDir(options.env));
  await mkdir(layout.root, { recursive: true });
  const lock = await acquireProcessLock(layout.supervisorLockFile);
  const log: FileHandle = await open(layout.daemonLogFile, "a", 0o600);
  const port = options.port ?? DEFAULT_ENGINE_PORT;
  const restartDelayMs = options.restartDelayMs ?? 100;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  let state: SupervisorRuntimeState = {
    pid: process.pid,
    port,
    startedAt: Date.now(),
    restartCount: 0,
    stopping: false,
  };
  let child: ChildProcess | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setInterval> | undefined;
  let stopWatcher: FSWatcher | undefined;
  let finishing: Promise<void> | undefined;
  let finishRun: (() => void) | undefined;
  const runFinished = new Promise<void>((resolveRun) => {
    finishRun = resolveRun;
  });

  let persistChain: Promise<void> = Promise.resolve();

  const persistSnapshot = (snapshot: SupervisorRuntimeState): Promise<void> => {
    const write = persistChain.then(() =>
      writeSupervisorState(layout.supervisorStateFile, snapshot),
    );
    persistChain = write.catch(() => undefined);
    return write;
  };

  const enqueuePersist = (): void => {
    void persistSnapshot(state).catch((error: unknown) => console.error(error));
  };

  const stopWatching = () => {
    if (fallbackTimer !== undefined) {
      clearInterval(fallbackTimer);
      fallbackTimer = undefined;
    }
    if (stopWatcher !== undefined) {
      stopWatcher.close();
      stopWatcher = undefined;
    }
  };

  const finish = () => {
    finishing ??= (async () => {
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
      stopWatching();
      process.off("SIGINT", requestStop);
      process.off("SIGTERM", requestStop);
      await persistChain;
      const enginePid = child?.pid;
      if (enginePid !== undefined) {
        await removeEngineState(layout.stateFile, enginePid).catch(() => undefined);
      }
      await removeSupervisorState(layout.supervisorStateFile, process.pid).catch(() => undefined);
      await rm(layout.supervisorStopFile, { force: true }).catch(() => undefined);
      await log.close().catch(() => undefined);
      await lock.release().catch(() => undefined);
      finishRun?.();
    })();
    return finishing;
  };

  const requestStop = () => {
    if (state.stopping) return;
    state = { ...state, stopping: true };
    stopWatching();
    enqueuePersist();
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
      void finish();
      return;
    }
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      void finish();
      return;
    }
    if (child.connected) {
      child.send({ type: "eevee:shutdown" }, (error) => {
        if (error !== null && error !== undefined && !state.stopping) console.error(error);
      });
    } else {
      child.kill("SIGTERM");
    }
    shutdownTimer = setTimeout(() => {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, shutdownTimeoutMs);
  };

  const startEngine = () => {
    if (state.stopping) {
      void finish();
      return;
    }
    const spawned = spawn(
      process.execPath,
      [
        ...process.execArgv,
        resolve(options.cliEntry),
        "start",
        "--foreground",
        "--port",
        String(port),
      ],
      {
        cwd: layout.root,
        env: { ...process.env, ...options.env, EEVEE_HOME: layout.root },
        stdio: ["ignore", log.fd, log.fd, "ipc"],
        windowsHide: true,
      },
    );
    child = spawned;
    state = { ...state, enginePid: spawned.pid };
    enqueuePersist();
    spawned.once("error", (error) => console.error(error));
    spawned.once("close", () => {
      if (child !== spawned) return;
      if (shutdownTimer !== undefined) {
        clearTimeout(shutdownTimer);
        shutdownTimer = undefined;
      }
      if (spawned.pid !== undefined) {
        void removeEngineState(layout.stateFile, spawned.pid).catch(() => undefined);
      }
      child = undefined;
      if (state.stopping) {
        void finish();
        return;
      }
      state = {
        ...state,
        enginePid: undefined,
        restartCount: state.restartCount + 1,
      };
      enqueuePersist();
      const delay = Math.min(restartDelayMs * 2 ** Math.max(0, state.restartCount - 1), 2_000);
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        startEngine();
      }, delay);
    });
  };

  let checkingStop = false;
  let recheckStop = false;
  const checkStopFile = () => {
    if (state.stopping) return;
    if (checkingStop) {
      recheckStop = true;
      return;
    }
    checkingStop = true;
    void isSupervisorStopRequested(layout)
      .then((requested) => {
        if (requested) requestStop();
      })
      .catch(() => undefined)
      .finally(() => {
        checkingStop = false;
        if (recheckStop && !state.stopping) {
          recheckStop = false;
          checkStopFile();
        }
      });
  };

  try {
    const previous = await readSupervisorState(layout.supervisorStateFile);
    if (previous !== undefined && previous.pid !== process.pid) {
      throw new Error(`Supervisor state is owned by process ${previous.pid}`);
    }
    await rm(layout.supervisorStopFile, { force: true });
    await persistSnapshot(state);
    const stopFileName = basename(layout.supervisorStopFile);
    try {
      stopWatcher = watch(dirname(layout.supervisorStopFile), (_eventType, filename) => {
        if (filename === null || filename === undefined || String(filename) === stopFileName) {
          checkStopFile();
        }
      });
      stopWatcher.on("error", () => {
        stopWatcher?.close();
        stopWatcher = undefined;
      });
    } catch {
      stopWatcher = undefined;
    }
    fallbackTimer = setInterval(checkStopFile, 500);
    fallbackTimer.unref?.();
    checkStopFile();
    process.on("SIGINT", requestStop);
    process.on("SIGTERM", requestStop);
    startEngine();
    await runFinished;
  } catch (error) {
    await finish();
    throw error;
  }
}
