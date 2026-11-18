import { Command } from "commander";
import { version } from "../shared/package.ts";

export type CliActions = {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<void>;
  web(): Promise<void>;
};

/** The command line only runs the Engine and opens the panel; everything else happens in the panel. */
export function createProgram(actions: CliActions): Command {
  const program = new Command()
    .name("eevee")
    .description("主动型智能体。不带命令时启动 Engine 并打开面板")
    .version(version)
    .allowExcessArguments()
    .action(async (_options: unknown, command: Command) => {
      const [unknown] = command.args;
      if (unknown !== undefined) command.error(`没有命令 ${unknown}，见 eevee --help`);
      await actions.start();
      await actions.web();
    });

  program
    .command("start")
    .description("在后台启动 Engine")
    .action(() => actions.start());
  program
    .command("stop")
    .description("停止 Engine")
    .action(() => actions.stop());
  program
    .command("status")
    .description("查看运行状态与项目")
    .action(() => actions.status());
  program
    .command("web")
    .description("在浏览器中打开并授权面板")
    .action(() => actions.web());

  return program;
}
