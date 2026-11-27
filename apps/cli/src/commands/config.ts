import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigBundleSchema, type EngineSettings, parseWithSchema } from "@eevee/protocol";
import type { Command } from "commander";
import {
  addModelSlotOptions,
  addToolSettingsOptions,
  hasModelSlots,
  parseModelSlotFlags,
  parseNonNegativeIntFlag,
  parsePositiveIntFlag,
  parseToolsSettingsFlags,
  readJsonInput,
} from "../args.ts";
import { runEngineCommand } from "../command-helpers.ts";
import { formatSettings } from "../format.ts";

export function registerConfigCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const configCommand = program
    .command("config")
    .description("Manage global Engine settings and config bundles");

  configCommand
    .command("get")
    .description("Show global Engine settings")
    .option("--json", "Output JSON")
    .action((options: { json?: boolean }) =>
      runEngineCommand(env, options, (client) => client.getSettings(), formatSettings),
    );

  const configSetCommand = configCommand
    .command("set")
    .description("Update global Engine settings")
    .option("--max-active-workers <n>", "Max concurrent active Workers per project")
    .option("--background-after-ms <n>", "Auto-background foreground commands after ms")
    .option("--router-context-tokens <n>", "Target Router context token budget")
    .option("--idle-hibernate-ms <n>", "Idle project hibernation timeout in ms (0 disables)");
  addModelSlotOptions(configSetCommand, "Default");
  addToolSettingsOptions(configSetCommand)
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
        routerTools?: string | readonly string[];
        workerTools?: string | readonly string[];
        codemodeMode?: string;
        codemodeInlineBudget?: string;
        json?: boolean;
      }) => {
        const models = parseModelSlotFlags(options);
        const tools = parseToolsSettingsFlags(options);

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
          ...(tools === undefined ? {} : { tools }),
        };

        if (Object.keys(patch).length === 0) {
          throw new Error("Specify at least one setting option to update.");
        }

        await runEngineCommand(
          env,
          options,
          (client) => client.patchSettings(patch),
          formatSettings,
        );
      },
    );

  configCommand
    .command("export")
    .description("Export Engine settings, profiles, MCP servers, and models.json")
    .option("--file <path>", "Write exported config bundle to a file")
    .option("--json", "Output JSON")
    .action((options: { file?: string; json?: boolean }) =>
      runEngineCommand(
        env,
        options,
        async (client) => {
          const bundle = await client.exportConfig();
          if (options.file !== undefined) {
            await writeFile(resolve(options.file), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
          }
          return bundle;
        },
        (bundle) =>
          options.file !== undefined
            ? `Exported configuration to ${resolve(options.file)}`
            : JSON.stringify(bundle, null, 2),
      ),
    );

  configCommand
    .command("import")
    .description("Import an exported config bundle from a JSON file or stdin")
    .option("--file <path>", "Path to exported config bundle JSON file")
    .option("--json", "Output JSON")
    .action(async (options: { file?: string; json?: boolean }) => {
      const parsed = await readJsonInput(options.file);
      const bundle = parseWithSchema(ConfigBundleSchema, parsed, "ConfigBundle");
      await runEngineCommand(
        env,
        options,
        (client) => client.importConfig(bundle),
        () => "Imported configuration bundle.",
      );
    });
}
