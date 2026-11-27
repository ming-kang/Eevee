import {
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  parseWithSchema,
} from "@eevee/protocol";
import type { Command } from "commander";
import { readJsonInput } from "../args.ts";
import { runEngineCommand } from "../command-helpers.ts";
import {
  formatModelProfiles,
  formatModels,
  formatRefreshModels,
  formatReloadModels,
} from "../format.ts";

export function registerModelsCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const modelsCommand = program.command("models").description("Inspect and manage models");

  modelsCommand
    .command("list")
    .description("List available and configured chat models")
    .option("--provider <id>", "Filter by provider ID")
    .option("--available", "Show only configured/available models")
    .option("--json", "Output JSON")
    .action((options: { provider?: string; available?: boolean; json?: boolean }) =>
      runEngineCommand(
        env,
        options,
        (client) =>
          client.listModels({
            ...(options.provider === undefined ? {} : { provider: options.provider }),
            ...(options.available ? { available: true } : {}),
          }),
        formatModels,
      ),
    );

  modelsCommand
    .command("refresh")
    .description("Refresh dynamic provider model catalogs")
    .option("--provider <ids...>", "Restrict refresh to these provider IDs")
    .option("--force", "Bypass freshness checks")
    .option("--json", "Output JSON")
    .action((options: { provider?: string[]; force?: boolean; json?: boolean }) =>
      runEngineCommand(
        env,
        options,
        (client) =>
          client.refreshModels({
            ...(options.provider === undefined ? {} : { providers: options.provider }),
            ...(options.force ? { force: true } : {}),
          }),
        formatRefreshModels,
      ),
    );

  modelsCommand
    .command("reload")
    .description("Reload models.json and report diagnostics")
    .option("--json", "Output JSON")
    .action((options: { json?: boolean }) =>
      runEngineCommand(env, options, (client) => client.reloadModels(), formatReloadModels),
    );

  const profilesCommand = modelsCommand
    .command("profiles")
    .description("Get or set Router model profiles");

  profilesCommand
    .command("get")
    .description("Get model profiles document")
    .option("--json", "Output JSON")
    .action((options: { json?: boolean }) =>
      runEngineCommand(env, options, (client) => client.getModelProfiles(), formatModelProfiles),
    );

  profilesCommand
    .command("set")
    .description("Replace model profiles document from a JSON file or stdin")
    .option("--file <path>", "Path to ModelProfilesDocument JSON file")
    .option("--json", "Output JSON")
    .action(async (options: { file?: string; json?: boolean }) => {
      const parsed = await readJsonInput(options.file);
      const doc: ModelProfilesDocument = parseWithSchema(
        ModelProfilesDocumentSchema,
        parsed,
        "ModelProfilesDocument",
      );
      await runEngineCommand(
        env,
        options,
        (client) => client.putModelProfiles(doc),
        (updated) => `Updated ${updated.profiles.length} model profile(s).`,
      );
    });
}
