#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import { engineEntry, version } from "../shared/package.ts";
import { eeveePaths } from "../shared/paths.ts";
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

const model = program.command("model").description("模型与凭据");

model
  .command("list")
  .description("查看默认模型、已登录 provider 的模型与使用经验")
  .action(async () => {
    const { client } = await connect(paths);
    console.log((await client.call("GET /api/models")).catalog);
  });

model
  .command("default <model>")
  .description("设置默认模型，格式 provider/modelId")
  .option("-r, --role <role>", "只为某个角色设置：router、worker 或 dreamer", "default")
  .action(async (ref: string, options: { role: string }) => {
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) throw new Error("模型格式应为 provider/modelId");
    const { client } = await connect(paths);
    await client.call("POST /api/settings/models", {
      role: options.role as "default",
      provider: ref.slice(0, slash),
      modelId: ref.slice(slash + 1),
    });
    console.log(`已设置 ${options.role} 模型为 ${ref}`);
  });

model
  .command("login <provider>")
  .description("保存 provider 的 API key（从标准输入读取）")
  .action(async (provider: string) => {
    const key = (await readStdin()).trim();
    if (!key) throw new Error("没有读到 API key：echo $KEY | eevee model login <provider>");
    const { client } = await connect(paths);
    await client.call("POST /api/auth/:provider", { provider }, { key });
    console.log(`已保存 ${provider} 的凭据`);
  });

const project = program.command("project").description("管理项目");

project
  .command("create <title>")
  .description("新建项目")
  .requiredOption("-w, --workspace <dir>", "关联的工作目录")
  .action(async (title: string, options: { workspace: string }) => {
    const { client } = await connect(paths);
    const created = await client.call("POST /api/projects", {
      title,
      workspace: resolve(options.workspace),
    });
    console.log(`已创建 ${created.id}「${created.title}」`);
  });

project
  .command("say <id> <text...>")
  .description("给项目的 Router 发一条消息（开发调试用）")
  .action(async (id: string, words: string[]) => {
    const { client } = await connect(paths);
    await client.call(
      "POST /api/projects/:project/messages",
      { project: id },
      { text: words.join(" ") },
    );
    console.log("已发送。");
  });

project
  .command("board <id>")
  .description("查看项目的工单与待回答问题")
  .action(async (id: string) => {
    const { client } = await connect(paths);
    const board = await client.call("GET /api/projects/:project/board", { project: id });
    for (const q of board.openQuestions)
      console.log(`? ${q.id} ${q.items.map((i) => i.text).join(" / ")}`);
    for (const t of board.tickets) console.log(`${t.ticket.id} [${t.stage}] ${t.ticket.title}`);
    if (board.tickets.length === 0 && board.openQuestions.length === 0) console.log("还没有工单。");
  });

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stdout.write("API key: ");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    if (process.stdin.isTTY && chunk.includes(10)) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

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
