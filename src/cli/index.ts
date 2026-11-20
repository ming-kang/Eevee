#!/usr/bin/env node
import { spawn } from "node:child_process";
import { eeveePaths } from "../shared/paths.ts";
import { connect, findEngine } from "./connection.ts";
import { startEngine, stopEngine } from "./lifecycle.ts";
import { createProgram } from "./program.ts";

const paths = eeveePaths();

const program = createProgram({
  async start(options) {
    const result = await startEngine(paths, options);
    if (result)
      console.log(
        `${result.started ? "Started" : "Already running"}: ${result.connection.baseUrl}/ui/ (pid ${result.connection.record.pid})`,
      );
  },

  async stop() {
    console.log((await stopEngine(paths)) ? "Stopped." : "The Engine is not running.");
  },

  async status() {
    const running = await findEngine(paths);
    if (!running) return console.log("The Engine is not running.");
    const status = await running.client.call("GET /api/engine");
    const uptime = Math.max(0, Math.floor((Date.now() - status.startedAt) / 1000));
    console.log(
      `Eevee ${status.version} · pid ${status.pid} · port ${status.port} · bootId ${status.bootId} · uptime ${uptime}s\nPanel: ${running.baseUrl}/ui/`,
    );
    for (const p of (await running.client.call("GET /api/projects")).projects)
      console.log(`  ${p.id}  ${p.title}  ${p.workspaces.join(", ")}`);
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
