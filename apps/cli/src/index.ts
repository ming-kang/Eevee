#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dataDirLayout, ENGINE_VERSION, resolveDataDir } from "@eevee/engine";
import { PROTOCOL_VERSION } from "@eevee/protocol";
import { Command } from "commander";

export function createProgram(env: NodeJS.ProcessEnv = process.env): Command {
  const program = new Command();
  program.name("eevee").description("Eevee proactive agent CLI").version(ENGINE_VERSION);

  program
    .command("info")
    .description("Show resolved Eevee home layout and protocol version")
    .action(() => {
      const layout = dataDirLayout(resolveDataDir(env));
      console.log(
        JSON.stringify(
          {
            engineVersion: ENGINE_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            home: layout.root,
            authFile: layout.authFile,
            modelsFile: layout.modelsFile,
            engineDb: layout.engineDb,
          },
          null,
          2,
        ),
      );
    });

  return program;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await createProgram().parseAsync(process.argv);
}
