import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsStore } from "../config/settings.ts";
import { Engine } from "../engine/engine.ts";
import { createModelRuntime } from "../engine/models/index.ts";
import { Auth } from "../server/auth.ts";
import { createHttpServer } from "../server/http.ts";
import { createRoutes } from "../server/routes.ts";
import { attachStream } from "../server/stream.ts";
import { uiDir, version } from "../shared/package.ts";
import { type EeveePaths, eeveePaths } from "../shared/paths.ts";
import {
  acquireLock,
  type RuntimeRecord,
  removeRuntimeRecord,
  writeRuntimeRecord,
} from "./instance.ts";

export async function runEngine(paths: EeveePaths = eeveePaths()): Promise<void> {
  const release = await acquireLock(paths.runtime.lock);
  let engine: Engine | undefined;
  let server: Server | undefined;
  let stream: ReturnType<typeof attachStream> | undefined;
  let record: RuntimeRecord | undefined;
  let failure: unknown;
  let stopping = false;
  let finish: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shutdown = () => {
    stopping = true;
    finish();
  };
  const fatal = (error: unknown) => {
    failure = error;
    shutdown();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", fatal);
  process.on("uncaughtException", fatal);
  const start = async () => {
    await rm(paths.runtime.record, { force: true });
    const store = await SettingsStore.open(paths.settings);
    if (stopping) return;
    const models = await createModelRuntime(paths);
    if (stopping) return;
    engine = await Engine.open({
      paths,
      settings: store,
      models,
      context: BACKGROUND_CONTEXT,
      client: { name: "eevee", version },
    });
    if (stopping) return;
    const auth = new Auth();
    let port = store.current.port;
    server = createHttpServer({
      routes: createRoutes({ engine, auth, port: () => port, version, shutdown }),
      auth,
      uiDir: uiDir(),
    });
    stream = attachStream(server, { source: engine, auth, version });
    port = await listen(server, port);
    if (stopping) return;
    record = {
      pid: process.pid,
      port,
      bootId: engine.bootId,
      version,
      startedAt: engine.startedAt,
      token: auth.token,
    };
    await writeRuntimeRecord(paths.runtime.record, record);
    if (!stopping)
      console.log(
        `Eevee ${version} is running.\nPanel: http://127.0.0.1:${port}/ui/\nData directory: ${paths.home}`,
      );
    await stopped;
  };
  try {
    await start();
  } catch (error) {
    failure = error;
  } finally {
    const results = await Promise.allSettled([
      stream?.close(),
      server === undefined ? undefined : closeServer(server),
      engine?.close(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    try {
      if (record !== undefined) await removeRuntimeRecord(paths.runtime.record, record);
    } catch (error) {
      errors.push(error);
    }
    try {
      await release();
    } catch (error) {
      errors.push(error);
    }
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    process.off("unhandledRejection", fatal);
    process.off("uncaughtException", fatal);
    if (errors.length)
      failure = new AggregateError(
        [...(failure === undefined ? [] : [failure]), ...errors],
        "Engine cleanup failed",
      );
  }
  if (failure !== undefined) throw failure;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
        reject(error);
      else resolve();
    });
  });
}

function listen(server: Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") return reject(error);
      server.listen(0, "127.0.0.1");
    };
    server.on("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : preferred);
    });
    server.listen(preferred, "127.0.0.1");
  });
}

if (import.meta.main) {
  try {
    await runEngine();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
