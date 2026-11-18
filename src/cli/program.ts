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
    .description("A proactive agent. With no command it starts the Engine and opens the panel")
    .version(version)
    .allowExcessArguments()
    .action(async (_options: unknown, command: Command) => {
      const [unknown] = command.args;
      if (unknown !== undefined) command.error(`No command ${unknown}; see eevee --help`);
      await actions.start();
      await actions.web();
    });

  program
    .command("start")
    .description("Start the Engine in the background")
    .action(() => actions.start());
  program
    .command("stop")
    .description("Stop the Engine")
    .action(() => actions.stop());
  program
    .command("status")
    .description("Show the run status and the projects")
    .action(() => actions.status());
  program
    .command("web")
    .description("Open and authorize the panel in a browser")
    .action(() => actions.web());

  return program;
}
