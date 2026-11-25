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

export const DEFAULT_ENGINE_HOST = "127.0.0.1";
export const DEFAULT_ENGINE_PORT = 4173;

export type StartForegroundEngineOptions = {
  readonly dataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly port?: number;
  readonly models?: Models | (() => Models);
  readonly credentials?: CredentialStore;
  readonly openProjectStorage?: OpenProjectStorage;
  readonly createMcpTransport?: McpHubOptions["createTransport"];
  readonly defaultModelSlots?: ModelSlots;
  readonly maxActiveWorkers?: number;
  readonly backgroundAfterMs?: number;
  readonly routerContextTokens?: number;
  readonly idleHibernateMs?: number;
  readonly onReport?: (projectId: string, report: Report) => void;
  readonly onPumpError?: (projectId: string, error: unknown) => void;
};

export type ForegroundEngineHandle = {
  readonly layout: DataDirLayout;
  readonly state: EngineRuntimeState;
  readonly token: string;
  readonly engine: Engine;
  readonly url: string;
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
  const token = await ensureAuthToken(layout.tokenFile);
  const engine = await Engine.open({
    dataDir: root,
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

  let httpServer: EngineHttpServer;
  try {
    httpServer = await startEngineHttpServer(engine, {
      host,
      port: options.port ?? DEFAULT_ENGINE_PORT,
      token,
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
  return {
    layout,
    state,
    token,
    engine,
    url: httpServer.url,
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
