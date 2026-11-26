import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connectLocalEngine } from "@eevee/engine";
import { ConfigBundleSchema, type EngineSettings, parseWithSchema } from "@eevee/protocol";
import type { Command } from "commander";
import {
  hasModelSlots,
  parseModelSlotFlags,
  parseNonNegativeIntFlag,
  parsePositiveIntFlag,
  readJsonInput,
} from "../args.ts";
import { formatSettings } from "../format.ts";

export function registerConfigCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const configCommand = program
    .command("config")
    .description("Manage global Engine settings and config bundles");

  configCommand
    .command("get")
    .description("Show global Engine settings")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const settings = await client.getSettings();
      if (options.json) {
        console.log(JSON.stringify(settings, null, 2));
        return;
      }
      console.log(formatSettings(settings));
    });

  configCommand
    .command("set")
    .description("Update global Engine settings")
    .option("--max-active-workers <n>", "Max concurrent active Workers per project")
    .option("--background-after-ms <n>", "Auto-background foreground commands after ms")
    .option("--router-context-tokens <n>", "Target Router context token budget")
    .option("--idle-hibernate-ms <n>", "Idle project hibernation timeout in ms (0 disables)")
    .option("--router-model <provider/modelId>", "Default Router model")
    .option("--worker-model <provider/modelId>", "Default Worker model")
    .option("--dreamer-model <provider/modelId>", "Default Dreamer model")
    .option("--json", "Output JSON")
    .action(
      async (options: {
        maxActiveWorkers?: string;
        backgroundAfterMs?: string;
        routerContextTokens?: string;
        idleHibernateMs?: string;
        routerModel?: string;
        workerModel?: string;
        dreamerModel?: string;
        json?: boolean;
      }) => {
        const models = parseModelSlotFlags(options);

        const patch: EngineSettings = {
          ...(options.maxActiveWorkers === undefined
            ? {}
            : {
                maxActiveWorkers: parseNonNegativeIntFlag(
                  options.maxActiveWorkers,
                  "--max-active-workers",
                ),
              }),
          ...(options.backgroundAfterMs === undefined
            ? {}
            : {
                backgroundAfterMs: parseNonNegativeIntFlag(
                  options.backgroundAfterMs,
                  "--background-after-ms",
                ),
              }),
          ...(options.routerContextTokens === undefined
            ? {}
            : {
                routerContextTokens: parsePositiveIntFlag(
                  options.routerContextTokens,
                  "--router-context-tokens",
                ),
              }),
          ...(options.idleHibernateMs === undefined
            ? {}
            : {
                idleHibernateMs: parseNonNegativeIntFlag(
                  options.idleHibernateMs,
                  "--idle-hibernate-ms",
                ),
              }),
          ...(hasModelSlots(models) ? { models } : {}),
        };

        if (Object.keys(patch).length === 0) {
          throw new Error("Specify at least one setting option to update.");
        }

        const { client } = await connectLocalEngine(env);
        const settings = await client.patchSettings(patch);
        if (options.json) {
          console.log(JSON.stringify(settings, null, 2));
          return;
        }
        console.log(formatSettings(settings));
      },
    );

  configCommand
    .command("export")
    .description("Export Engine settings, profiles, MCP servers, and models.json")
    .option("--file <path>", "Write exported config bundle to a file")
    .option("--json", "Output JSON")
    .action(async (options: { file?: string; json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const bundle = await client.exportConfig();
      const text = `${JSON.stringify(bundle, null, 2)}\n`;
      if (options.file !== undefined) {
        await writeFile(resolve(options.file), text, "utf8");
        if (options.json) {
          console.log(JSON.stringify(bundle, null, 2));
        } else {
          console.log(`Exported configuration to ${resolve(options.file)}`);
        }
        return;
      }
      process.stdout.write(text);
    });

  configCommand
    .command("import")
    .description("Import an exported config bundle from a JSON file or stdin")
    .option("--file <path>", "Path to exported config bundle JSON file")
    .option("--json", "Output JSON")
    .action(async (options: { file?: string; json?: boolean }) => {
      const parsed = await readJsonInput(options.file);
      const bundle = parseWithSchema(ConfigBundleSchema, parsed, "ConfigBundle");
      const { client } = await connectLocalEngine(env);
      const applied = await client.importConfig(bundle);
      if (options.json) {
        console.log(JSON.stringify(applied, null, 2));
        return;
      }
      console.log("Imported configuration bundle.");
    });
}
