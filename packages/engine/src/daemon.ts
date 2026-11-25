import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EeveeClient } from "@eevee/protocol";
import { readAuthToken, readEngineState, removeEngineState } from "./auth.ts";
import { type DataDirLayout, dataDirLayout, resolveDataDir } from "./data-dir.ts";
import { acquireProcessLock, isProcessAlive } from "./process-lock.ts";
import { DEFAULT_ENGINE_PORT } from "./server.ts";

export type SupervisorRuntimeState = {
  readonly pid: number;
  readonly enginePid?: number;
  readonly port: number;
  readonly startedAt: number;
  readonly restartCount: number;
  readonly stopping: boolean;
};

export type DaemonStatus = {
  readonly status: "running" | "starting" | "restarting" | "stopping" | "stopped";
  readonly supervisorPid?: number;
  readonly enginePid?: number;
  readonly url?: string;
  readonly restartCount: number;
  readonly startedAt?: number;
  readonly engineStartedAt?: number;
};

export type DaemonControlOptions = {
  readonly dataDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
};

export type StartDaemonOptions = DaemonControlOptions & {
  readonly cliEntry: string;
  readonly port?: number;
};

export type DaemonStartResult = DaemonStatus & {
  readonly outcome: "started" | "already_running";
};

export type DaemonStopResult = {
  readonly outcome: "stopped" | "already_stopped";
};

function isSupervisorState(value: unknown): value is SupervisorRuntimeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    (candidate.enginePid === undefined ||
      (typeof candidate.enginePid === "number" &&
        Number.isInteger(candidate.enginePid) &&
        candidate.enginePid > 0)) &&
    typeof candidate.port === "number" &&
    Number.isInteger(candidate.port) &&
    candidate.port >= 0 &&
    candidate.port <= 65535 &&
    typeof candidate.startedAt === "number" &&
    typeof candidate.restartCount === "number" &&
    Number.isInteger(candidate.restartCount) &&
    candidate.restartCount >= 0 &&
    typeof candidate.stopping === "boolean"
  );
}

export async function readSupervisorState(
  stateFile: string,
): Promise<SupervisorRuntimeState | undefined> {
  let raw: string;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSupervisorState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeSupervisorState(
  stateFile: string,
  state: SupervisorRuntimeState,
): Promise<void> {
  await writeJsonAtomic(stateFile, state);
}

export async function removeSupervisorState(
  stateFile: string,
  expectedPid?: number,
): Promise<void> {
  if (expectedPid !== undefined) {
    const current = await readSupervisorState(stateFile);
    if (current === undefined || current.pid !== expectedPid) return;
  }
  await rm(stateFile, { force: true });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function daemonLayout(options: DaemonControlOptions): DataDirLayout {
  return dataDirLayout(options.dataDir ?? resolveDataDir(options.env));
}

async function healthyEngine(
  layout: DataDirLayout,
): Promise<{ readonly pid: number; readonly url: string; readonly startedAt: number } | undefined> {
  const state = await readEngineState(layout.stateFile);
  if (state === undefined || !isProcessAlive(state.pid)) return undefined;
  const token = await readAuthToken(layout.tokenFile);
  if (token === undefined) return undefined;
  try {
    const client = new EeveeClient({ baseUrl: state.url, token });
    const health = await client.health(AbortSignal.timeout(500));
    if (!health.ok || health.pid !== state.pid) return undefined;
    return { pid: state.pid, url: state.url, startedAt: state.startedAt };
  } catch {
    return undefined;
  }
}

export async function getDaemonStatus(options: DaemonControlOptions = {}): Promise<DaemonStatus> {
  const layout = daemonLayout(options);
  const supervisor = await readSupervisorState(layout.supervisorStateFile);
  const supervisorAlive = supervisor !== undefined && isProcessAlive(supervisor.pid);
  const healthy = await healthyEngine(layout);
  if (supervisorAlive && supervisor.stopping) {
    return {
      status: "stopping",
      supervisorPid: supervisor.pid,
      ...(supervisor.enginePid === undefined ? {} : { enginePid: supervisor.enginePid }),
      restartCount: supervisor.restartCount,
      startedAt: supervisor.startedAt,
    };
  }
  if (healthy !== undefined && (!supervisorAlive || supervisor.enginePid === healthy.pid)) {
    return {
      status: "running",
      ...(supervisorAlive ? { supervisorPid: supervisor.pid } : {}),
      enginePid: healthy.pid,
      url: healthy.url,
      restartCount: supervisorAlive ? supervisor.restartCount : 0,
      ...(supervisorAlive ? { startedAt: supervisor.startedAt } : {}),
      engineStartedAt: healthy.startedAt,
    };
  }
  if (supervisorAlive) {
    return {
      status: supervisor.restartCount > 0 ? "restarting" : "starting",
      supervisorPid: supervisor.pid,
      ...(supervisor.enginePid === undefined ? {} : { enginePid: supervisor.enginePid }),
      restartCount: supervisor.restartCount,
      startedAt: supervisor.startedAt,
    };
  }
  return { status: "stopped", restartCount: 0 };
}

export async function startDaemon(options: StartDaemonOptions): Promise<DaemonStartResult> {
  const layout = daemonLayout(options);
  const port = options.port ?? DEFAULT_ENGINE_PORT;
  const timeoutMs = options.timeoutMs ?? 20_000;
  await mkdir(layout.root, { recursive: true });
  const startLock = await acquireProcessLock(layout.startLockFile, { timeoutMs });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const initial = await getDaemonStatus(options);
    const previousSupervisor = await readSupervisorState(layout.supervisorStateFile);
    if (initial.status === "stopping") {
      throw new Error("Eevee engine is stopping; retry after it stops");
    }
    if (initial.status === "running") {
      const wasSupervised =
        previousSupervisor !== undefined && !isProcessAlive(previousSupervisor.pid);
      if (initial.supervisorPid !== undefined || !wasSupervised) {
        return { ...initial, outcome: "already_running" };
      }
      if (previousSupervisor !== undefined) {
        await stopVerifiedOrphanEngine(layout, timeoutMs);
        await removeSupervisorState(layout.supervisorStateFile, previousSupervisor.pid);
      }
    }

    let supervisorPid: number;
    if (initial.supervisorPid !== undefined) {
      supervisorPid = initial.supervisorPid;
    } else {
      if (previousSupervisor !== undefined && !isProcessAlive(previousSupervisor.pid)) {
        await removeSupervisorState(layout.supervisorStateFile, previousSupervisor.pid);
      }
      const previousEngine = await readEngineState(layout.stateFile);
      if (previousEngine !== undefined && !isProcessAlive(previousEngine.pid)) {
        await removeEngineState(layout.stateFile, previousEngine.pid);
      }
      await rm(layout.supervisorStopFile, { force: true });

      const log = await open(layout.daemonLogFile, "a", 0o600);
      try {
        child = spawn(
          process.execPath,
          [...process.execArgv, resolve(options.cliEntry), "__supervisor", "--port", String(port)],
          {
            cwd: layout.root,
            env: { ...process.env, ...options.env, EEVEE_HOME: layout.root },
            detached: true,
            stdio: ["ignore", log.fd, log.fd],
            windowsHide: true,
          },
        );
      } finally {
        await log.close();
      }
      if (child.pid === undefined) throw new Error("Failed to start Eevee supervisor process");
      supervisorPid = child.pid;
      child.unref();
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (child !== undefined && child.exitCode !== null) {
        throw new Error(
          `Eevee supervisor exited with code ${child.exitCode}; see ${layout.daemonLogFile}`,
        );
      }
      const status = await getDaemonStatus(options);
      if (status.status === "running" && status.supervisorPid === supervisorPid) {
        return {
          ...status,
          outcome: initial.supervisorPid === undefined ? "started" : "already_running",
        };
      }
      if (Date.now() >= deadline) {
        if (child !== undefined) {
          await writeJsonAtomic(layout.supervisorStopFile, { requestedAt: Date.now() }).catch(
            () => undefined,
          );
        }
        throw new Error(`Timed out waiting for Eevee engine; see ${layout.daemonLogFile}`);
      }
      await delay(40);
    }
  } finally {
    await startLock.release();
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(40);
  }
  return true;
}

async function stopVerifiedOrphanEngine(layout: DataDirLayout, timeoutMs: number): Promise<void> {
  const engine = await readEngineState(layout.stateFile);
  if (engine === undefined || !isProcessAlive(engine.pid)) return;
  const healthy = await healthyEngine(layout);
  if (healthy === undefined || healthy.pid !== engine.pid) {
    throw new Error(
      `Cannot verify Eevee engine identity for PID ${engine.pid}; refusing to signal this process`,
    );
  }
  const token = await readAuthToken(layout.tokenFile);
  if (token === undefined) {
    throw new Error(
      `Cannot verify Eevee engine identity for PID ${engine.pid}: missing auth token`,
    );
  }
  const client = new EeveeClient({ baseUrl: healthy.url, token });
  await client.shutdown(AbortSignal.timeout(2_000)).catch(() => undefined);
  if (!(await waitForProcessExit(engine.pid, timeoutMs))) {
    throw new Error(
      `Eevee engine ${engine.pid} did not exit after authenticated shutdown; refusing to force-kill by PID`,
    );
  }
}

export async function stopDaemon(options: DaemonControlOptions = {}): Promise<DaemonStopResult> {
  const layout = daemonLayout(options);
  const timeoutMs = options.timeoutMs ?? 20_000;
  await mkdir(layout.root, { recursive: true });
  const startLock = await acquireProcessLock(layout.startLockFile, { timeoutMs });
  try {
    const supervisor = await readSupervisorState(layout.supervisorStateFile);
    const engine = await readEngineState(layout.stateFile);
    const supervisorAlive = supervisor !== undefined && isProcessAlive(supervisor.pid);
    const engineAlive = engine !== undefined && isProcessAlive(engine.pid);
    if (!supervisorAlive && !engineAlive) {
      if (supervisor !== undefined) {
        await removeSupervisorState(layout.supervisorStateFile, supervisor.pid);
      }
      if (engine !== undefined) await removeEngineState(layout.stateFile, engine.pid);
      await rm(layout.supervisorStopFile, { force: true });
      return { outcome: "already_stopped" };
    }

    if (supervisorAlive) {
      await writeJsonAtomic(layout.supervisorStopFile, { requestedAt: Date.now() });
      const stopped = await waitForProcessExit(supervisor.pid, timeoutMs);
      if (!stopped) {
        throw new Error(
          `Timed out stopping Eevee supervisor ${supervisor.pid}; see ${layout.daemonLogFile}`,
        );
      }
    } else if (engineAlive) {
      await stopVerifiedOrphanEngine(layout, timeoutMs);
    }

    if (supervisor !== undefined) {
      await removeSupervisorState(layout.supervisorStateFile, supervisor.pid);
    }
    if (engine !== undefined) await removeEngineState(layout.stateFile, engine.pid);
    await rm(layout.supervisorStopFile, { force: true });
    return { outcome: "stopped" };
  } finally {
    await startLock.release();
  }
}

export async function requestSupervisorStop(layout: DataDirLayout): Promise<void> {
  await writeJsonAtomic(layout.supervisorStopFile, { requestedAt: Date.now() });
}

export async function isSupervisorStopRequested(layout: DataDirLayout): Promise<boolean> {
  return pathExists(layout.supervisorStopFile);
}
