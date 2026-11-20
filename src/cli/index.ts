#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { engineEntry } from "../shared/package.ts";
import { eeveePaths } from "../shared/paths.ts";
import { connect, findEngine } from "./connection.ts";
import { createProgram } from "./program.ts";

const paths = eeveePaths();

const program = createProgram({
  async start() {
    const running = await findEngine(paths);
    if (running) return console.log(`Already running: ${running.baseUrl}/ui/`);
    await mkdir(paths.runtime.dir, { recursive: true });
    const log = await open(join(paths.runtime.dir, "engine.log"), "a");
    const child = spawn(process.execPath, [engineEntry], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, EEVEE_HOME: paths.home },
    });
    child.unref();
    await log.close();
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const connection = await findEngine(paths);
      if (connection) return console.log(`Started: ${connection.baseUrl}/ui/`);
    }
    throw new Error(
      `Timed out waiting for the Engine to start. See the log: ${join(paths.runtime.dir, "engine.log")}`,
    );
  },

  async stop() {
    const running = await findEngine(paths);
    if (!running) return console.log("The Engine is not running.");
    await running.client.call("POST /api/engine/shutdown");
    console.log("Stopped.");
  },

  async status() {
    const running = await findEngine(paths);
    if (!running) return console.log("The Engine is not running.");
    const status = await running.client.call("GET /api/engine");
    console.log(`Eevee ${status.version} · ${running.baseUrl}/ui/ · pid ${running.record.pid}`);
    for (const p of (await running.client.call("GET /api/projects")).projects)
      console.log(`  ${p.id}  ${p.title}  ${p.workspace}`);
  },

  async web() {
    const { client, baseUrl } = await connect(paths);
    const { code } = await client.call("POST /api/session/codes");
    const url = `${baseUrl}/ui/#code=${encodeURIComponent(code)}`;
    openBrowser(url);
    console.log(
      `Opened the panel in your browser: ${url}\nThe authorization code is valid for 90 seconds.`,
    );
  },
});

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url.replaceAll("&", "^&")]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
