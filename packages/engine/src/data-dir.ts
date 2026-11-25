import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AUTH_FILE, MODELS_FILE, MODELS_STORE_FILE } from "@eevee/agent/models";

export const ENGINE_DB_FILE = "engine.sqlite";
export const PROJECT_DB_FILE = "session.sqlite";
export const ENGINE_TOKEN_FILE = "engine.token";
export const ENGINE_STATE_FILE = "engine.json";
export const SUPERVISOR_STATE_FILE = "supervisor.json";

export type DataDirLayout = {
  readonly root: string;
  readonly authFile: string;
  readonly modelsFile: string;
  readonly modelsStoreFile: string;
  readonly engineDb: string;
  readonly tokenFile: string;
  readonly stateFile: string;
  readonly supervisorStateFile: string;
  readonly supervisorStopFile: string;
  readonly supervisorLockFile: string;
  readonly runtimeLockFile: string;
  readonly startLockFile: string;
  readonly daemonLogFile: string;
  readonly projectsDir: string;
};

export type ProjectPaths = {
  readonly dir: string;
  readonly sessionDb: string;
  readonly logsDir: string;
};

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.EEVEE_HOME?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".eevee");
}

export function dataDirLayout(root: string): DataDirLayout {
  const resolved = resolve(root);
  return {
    root: resolved,
    authFile: join(resolved, AUTH_FILE),
    modelsFile: join(resolved, MODELS_FILE),
    modelsStoreFile: join(resolved, MODELS_STORE_FILE),
    engineDb: join(resolved, ENGINE_DB_FILE),
    tokenFile: join(resolved, ENGINE_TOKEN_FILE),
    stateFile: join(resolved, ENGINE_STATE_FILE),
    supervisorStateFile: join(resolved, SUPERVISOR_STATE_FILE),
    supervisorStopFile: join(resolved, "supervisor.stop"),
    supervisorLockFile: join(resolved, "supervisor.lock"),
    runtimeLockFile: join(resolved, "engine.lock"),
    startLockFile: join(resolved, "start.lock"),
    daemonLogFile: join(resolved, "daemon.log"),
    projectsDir: join(resolved, "projects"),
  };
}

export function projectPaths(layout: DataDirLayout, projectId: string): ProjectPaths {
  const dir = join(layout.projectsDir, projectId);
  return {
    dir,
    sessionDb: join(dir, PROJECT_DB_FILE),
    logsDir: join(dir, "logs"),
  };
}
