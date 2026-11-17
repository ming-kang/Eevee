import type { Command } from "commander";
import type { MemoryScope } from "../../contracts/index.ts";
import type { EeveePaths } from "../../shared/paths.ts";
import { connect } from "../connection.ts";

type ScopeOption = { global?: boolean };

const scopeOf = (options: ScopeOption): MemoryScope => (options.global ? "global" : "project");

export function memoryCommands(program: Command, paths: EeveePaths): void {
  const memory = program.command("memory").description("查看与撤销记忆库的改动");

  memory
    .command("log <project>")
    .description("记忆库的提交历史")
    .option("-g, --global", "全局记忆库")
    .action(async (project: string, options: ScopeOption) => {
      const { client } = await connect(paths);
      const { commits } = await client.call("GET /api/projects/:project/memory/:scope/log", {
        project,
        scope: scopeOf(options),
      });
      for (const c of commits) {
        console.log(`${c.commit}  ${c.at.slice(0, 16).replace("T", " ")}  ${c.subject}`);
      }
      if (commits.length === 0) console.log("还没有历史。");
    });

  memory
    .command("show <project> [commit]")
    .description("一次提交的改动；不给 commit 时显示还没提交的改动")
    .option("-g, --global", "全局记忆库")
    .action(async (project: string, commit: string | undefined, options: ScopeOption) => {
      const { client } = await connect(paths);
      const scope = scopeOf(options);
      const { diff } =
        commit === undefined
          ? await client.call("GET /api/projects/:project/memory/:scope/diff", { project, scope })
          : await client.call("GET /api/projects/:project/memory/:scope/commits/:commit", {
              project,
              scope,
              commit,
            });
      console.log(diff || "没有差异。");
    });

  memory
    .command("revert <project> <commit>")
    .description("撤销一次提交（生成一个新的反向提交）")
    .option("-g, --global", "全局记忆库")
    .action(async (project: string, commit: string, options: ScopeOption) => {
      const { client } = await connect(paths);
      await client.call(
        "POST /api/projects/:project/memory/:scope/revert",
        { project, scope: scopeOf(options) },
        { commit },
      );
      console.log(`已撤销 ${commit}。`);
    });
}
