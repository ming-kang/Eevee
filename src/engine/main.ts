import type { Server } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModelRuntime } from "../models/index.ts";
import { Auth } from "../server/auth.ts";
import { createHttpServer } from "../server/http.ts";
import { createRoutes } from "../server/routes.ts";
import { attachStream } from "../server/stream.ts";
import { uiDir, version } from "../shared/package.ts";
import { eeveePaths } from "../shared/paths.ts";
import { SettingsStore } from "../shared/settings.ts";
import { Engine } from "./engine.ts";
import { acquireLock, writeRuntimeRecord } from "./instance.ts";

const context = BACKGROUND_CONTEXT;
const paths = eeveePaths();
const store = await SettingsStore.open(paths.settings);
const settings = store.current;
const release = await acquireLock(paths.runtime.lock);

const models = await createModelRuntime(paths);
const engine = await Engine.open({
  paths,
  settings: store,
  models,
  context,
  client: { name: "eevee", version },
});
const auth = await Auth.open({
  cliTokenPath: paths.runtime.cliToken,
  sessionsPath: paths.runtime.sessions,
});

let port = settings.port;
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await stream.close();
  server.close();
  await engine.close();
  await release();
  process.exit(0);
};

const server = createHttpServer({
  routes: createRoutes({
    engine,
    auth,
    port: () => port,
    version,
    shutdown: () => void shutdown(),
  }),
  auth,
  uiDir: uiDir(),
});
const stream = attachStream(server, { source: engine, auth });
port = await listen(server, settings.port);
await writeRuntimeRecord(paths.runtime.record, {
  pid: process.pid,
  port,
  bootId: engine.bootId,
  startedAt: Date.now(),
});
console.log(`Eevee ${version} 已启动：http://127.0.0.1:${port}/ui/（数据目录 ${paths.home}）`);

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function listen(server: Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") return reject(error);
      server.listen(0, "127.0.0.1");
    };
    server.on("error", onError);
    server.on("listening", () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : preferred);
    });
    server.listen(preferred, "127.0.0.1");
  });
}
