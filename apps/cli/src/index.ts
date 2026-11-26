#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENGINE_VERSION } from "@eevee/engine";
import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.ts";
import { registerConfigCommands } from "./commands/config.ts";
import { registerConversationCommands } from "./commands/conversation.ts";
import { registerDaemonCommands } from "./commands/daemon.ts";
import { registerMcpCommands } from "./commands/mcp.ts";
import { registerModelsCommands } from "./commands/models.ts";
import { registerProjectCommands } from "./commands/project.ts";
import { registerTaskCommands } from "./commands/task.ts";

export function createProgram(env: NodeJS.ProcessEnv = process.env): Command {
  const program = new Command();
  program.name("eevee").description("Eevee proactive agent CLI").version(ENGINE_VERSION);

  registerDaemonCommands(program, env, fileURLToPath(import.meta.url));
  registerProjectCommands(program, env);
  registerAuthCommands(program, env);
  registerModelsCommands(program, env);
  registerMcpCommands(program, env);
  registerConfigCommands(program, env);
  registerConversationCommands(program, env);
  registerTaskCommands(program, env);

  return program;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
