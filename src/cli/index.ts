#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import { engineEntry, version } from "../shared/package.ts";
import { eeveePaths } from "../shared/paths.ts";
import { capabilityCommands } from "./commands/capabilities.ts";
import { memoryCommands } from "./commands/memory.ts";
import { modelCommands } from "./commands/model.ts";
import { projectCommands } from "./commands/project.ts";
import { connect, findEngine } from "./connection.ts";

const paths = eeveePaths();
const program = new Command().name("eevee").description("主动型智能体").version(version);

program
  .command("start")
  .description("在后台启动 Engine")
  .action(async () => {
    const running = await findEngine(paths);
    if (running) return console.log(`已经在运行：${running.baseUrl}/ui/`);
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
      if (connection) return console.log(`已启动：${connection.baseUrl}/ui/（eevee web 打开面板）`);
    }
    throw new Error(`启动超时，查看日志：${join(paths.runtime.dir, "engine.log")}`);
  });

program
  .command("stop")
  .description("停止 Engine")
  .action(async () => {
    const running = await findEngine(paths);
    if (!running) return console.log("没有在运行。");
    await running.client.call("POST /api/shutdown");
    console.log("已停止。");
  });

program
  .command("status")
  .description("查看运行状态与项目")
  .action(async () => {
    const running = await findEngine(paths);
    if (!running) return console.log("没有在运行。");
    const status = await running.client.call("GET /api/status");
    console.log(`Eevee ${status.version} · ${running.baseUrl}/ui/ · pid ${running.record.pid}`);
    for (const p of status.projects) console.log(`  ${p.id}  ${p.title}  ${p.workspace}`);
  });

program
  .command("web")
  .description("在浏览器中打开并授权面板")
  .action(async () => {
    const { client, baseUrl } = await connect(paths);
    const { code } = await client.call("POST /api/session/code");
    const url = `${baseUrl}/ui/#code=${encodeURIComponent(code)}`;
    openBrowser(url);
    console.log(`已在浏览器中打开（授权码 90 秒内有效）：${url}`);
  });

modelCommands(program, paths);
projectCommands(program, paths);
memoryCommands(program, paths);
capabilityCommands(program, paths);

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
