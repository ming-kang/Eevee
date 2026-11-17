import { resolve } from "node:path";
import type { Command } from "commander";
import type { UsageSummary } from "../../api/contract.ts";
import type { EeveePaths } from "../../shared/paths.ts";
import { connect } from "../connection.ts";

export function projectCommands(program: Command, paths: EeveePaths): void {
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
      for (const q of board.openQuestions) {
        console.log(`? ${q.id} ${q.items.map((i) => i.text).join(" / ")}`);
      }
      for (const t of board.tickets) {
        const jobs = t.jobs.length > 0 ? `（${t.jobs.length} 个后台作业）` : "";
        console.log(`${t.ticket.id} [${t.stage}] ${t.ticket.title}${jobs}`);
      }
      if (board.tickets.length === 0 && board.openQuestions.length === 0) {
        console.log("还没有工单。");
      }
    });

  project
    .command("usage <id>")
    .description("查看项目的 token 用量与花费")
    .action(async (id: string) => {
      const { client } = await connect(paths);
      const usage = await client.call("GET /api/projects/:project/usage", { project: id });
      console.log(`合计    ${describeUsage(usage.total)}`);
      console.log(`Router  ${describeUsage(usage.router)}`);
      for (const t of usage.tickets) {
        console.log(`${t.ticketId}「${t.title}」 ${describeUsage(t.usage)}`);
      }
      const models = Object.entries(usage.models);
      if (models.length > 0) console.log("\n按模型：");
      for (const [model, summary] of models) console.log(`  ${model}  ${describeUsage(summary)}`);
    });
}

function describeUsage(usage: UsageSummary): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return [
    `输入 ${k(usage.input)}`,
    `输出 ${k(usage.output)}`,
    `缓存读 ${k(usage.cacheRead)}`,
    `缓存写 ${k(usage.cacheWrite)}`,
    `$${usage.cost.toFixed(4)}`,
  ].join(" · ");
}
