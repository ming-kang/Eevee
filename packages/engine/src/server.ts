import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type { Report } from "@earendil-works/pi-durable";
import type { McpHubOptions } from "@eevee/agent";
import type { ModelSlots } from "@eevee/core";
import {
  type EngineRuntimeState,
  ensureAuthToken,
  removeEngineState,
  writeEngineState,
} from "./auth.ts";
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "./constants.ts";
import { type DataDirLayout, dataDirLayout, resolveDataDir } from "./data-dir.ts";
import { Engine, type OpenProjectStorage } from "./engine.ts";
import { type EngineHttpServer, startEngineHttpServer } from "./http.ts";
import { acquireProcessLock } from "./process-lock.ts";

export const DEFAULT_ENGINE_HOST = "127.0.0.1";
export const DEFAULT_ENGINE_PORT = 4173;

export type StartForegroundEngineOptions = {
  readonly dataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly port?: number;
  readonly webDistDir?: string | false;
  readonly models?: Models | (() => Models);
  readonly credentials?: CredentialStore;
  readonly openProjectStorage?: OpenProjectStorage;
  readonly createMcpTransport?: McpHubOptions["createTransport"];
  readonly defaultModelSlots?: ModelSlots;
  readonly maxActiveWorkers?: number;
  readonly backgroundAfterMs?: number;
  readonly routerContextTokens?: number;
  readonly idleHibernateMs?: number;
  readonly recoverProjects?: boolean;
  readonly onRecoveryError?: (error: unknown) => void;
  readonly onShutdown?: () => void;
  readonly onReport?: (projectId: string, report: Report) => void;
  readonly onPumpError?: (projectId: string, error: unknown) => void;
};

export type ForegroundEngineHandle = {
  readonly layout: DataDirLayout;
  readonly state: EngineRuntimeState;
  readonly token: string;
  readonly engine: Engine;
  readonly url: string;
  readonly recovery: Promise<void>;
  close(): Promise<void>;
};

export async function startForegroundEngine(
  options: StartForegroundEngineOptions = {},
): Promise<ForegroundEngineHandle> {
  const host = options.host ?? DEFAULT_ENGINE_HOST;
  if (host !== DEFAULT_ENGINE_HOST) {
    throw new Error(`Engine only listens on ${DEFAULT_ENGINE_HOST} (refused host "${host}")`);
  }

  const root = options.dataDir ?? resolveDataDir(options.env);
  const layout = dataDirLayout(root);
  const runtimeLock = await acquireProcessLock(layout.runtimeLockFile);
  let handle: ForegroundEngineHandle | undefined;
  try {
    await removeEngineState(layout.stateFile);
    handle = await startLockedForegroundEngine(layout, options);
    const started = handle;
    return {
      ...started,
      close: () => started.close().finally(() => runtimeLock.release()),
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await runtimeLock.release();
    throw error;
  }
}

async function startLockedForegroundEngine(
  layout: DataDirLayout,
  options: StartForegroundEngineOptions,
): Promise<ForegroundEngineHandle> {
  const token = await ensureAuthToken(layout.tokenFile);
  const engine = await Engine.open({
    dataDir: layout.root,
    env: options.env,
    models: options.models,
    credentials: options.credentials,
    openProjectStorage: options.openProjectStorage,
    createMcpTransport: options.createMcpTransport,
    defaultModelSlots: options.defaultModelSlots,
    maxActiveWorkers: options.maxActiveWorkers,
    backgroundAfterMs: options.backgroundAfterMs,
    routerContextTokens: options.routerContextTokens,
    idleHibernateMs: options.idleHibernateMs,
    onReport: options.onReport,
    onPumpError: options.onPumpError,
  });

  const host = options.host ?? DEFAULT_ENGINE_HOST;
  let httpServer: EngineHttpServer;
  try {
    httpServer = await startEngineHttpServer(engine, {
      host,
      port: options.port ?? DEFAULT_ENGINE_PORT,
      token,
      ...(options.webDistDir === undefined ? {} : { webDistDir: options.webDistDir }),
      ...(options.onShutdown === undefined ? {} : { onShutdown: options.onShutdown }),
    });
  } catch (error) {
    await engine.close().catch(() => undefined);
    throw error;
  }

  const state: EngineRuntimeState = {
    pid: process.pid,
    host: httpServer.host,
    port: httpServer.port,
    url: httpServer.url,
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    engineVersion: ENGINE_VERSION,
    startedAt: Date.now(),
  };

  try {
    await writeEngineState(layout.stateFile, state);
  } catch (error) {
    await httpServer.close().catch(() => undefined);
    await engine.close().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const recovery =
    options.recoverProjects === false
      ? Promise.resolve()
      : engine.recoverProjects().catch((error: unknown) => {
          options.onRecoveryError?.(error);
        });
  return {
    layout,
    state,
    token,
    engine,
    url: httpServer.url,
    recovery,
    close: () => {
      closePromise ??= (async () => {
        await removeEngineState(layout.stateFile, process.pid).catch(() => undefined);
        await httpServer.close().catch(() => undefined);
        await engine.close();
      })();
      return closePromise;
    },
  };
}
