import { Command } from "commander";
import { version } from "../shared/package.ts";

export type CliActions = {
  start(options?: { foreground?: boolean }): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<void>;
  web(): Promise<void>;
};

/** The command line only runs the Engine and opens the panel; everything else happens in the panel. */
export function createProgram(actions: CliActions): Command {
  const program = new Command()
    .name("eevee")
    .description("Start the Engine and open the panel")
    .version(version)
    .allowExcessArguments()
    .action(async (_options: unknown, command: Command) => {
      const [unknown] = command.args;
      if (unknown !== undefined)
        command.error(`No command ${unknown}. Run eevee --help to see the commands.`);
      await actions.start();
      await actions.web();
    });

  program
    .command("start")
    .description("Start the Engine (detached by default)")
    .option("--foreground", "Run in this process with logs in the terminal")
    .action((options: { foreground?: boolean }) => actions.start(options));
  program
    .command("stop")
    .description("Stop the Engine")
    .action(() => actions.stop());
  program
    .command("status")
    .description("Show Engine identity, uptime and projects")
    .action(() => actions.status());
  program
    .command("web")
    .description("Open and authorize the panel in a browser")
    .action(() => actions.web());

  return program;
}
