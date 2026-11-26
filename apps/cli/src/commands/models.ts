import { connectLocalEngine } from "@eevee/engine";
import {
  type ModelProfilesDocument,
  ModelProfilesDocumentSchema,
  parseWithSchema,
} from "@eevee/protocol";
import type { Command } from "commander";
import { readJsonInput } from "../args.ts";
import { formatModelProfiles, formatModels, formatRefreshModels } from "../format.ts";

export function registerModelsCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const modelsCommand = program.command("models").description("Inspect and manage models");

  modelsCommand
    .command("list")
    .description("List available and configured chat models")
    .option("--provider <id>", "Filter by provider ID")
    .option("--available", "Show only configured/available models")
    .option("--json", "Output JSON")
    .action(async (options: { provider?: string; available?: boolean; json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.listModels({
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.available ? { available: true } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatModels(response));
    });

  modelsCommand
    .command("refresh")
    .description("Refresh dynamic provider model catalogs")
    .option("--provider <ids...>", "Restrict refresh to these provider IDs")
    .option("--force", "Bypass freshness checks")
    .option("--json", "Output JSON")
    .action(async (options: { provider?: string[]; force?: boolean; json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const response = await client.refreshModels({
        ...(options.provider === undefined ? {} : { providers: options.provider }),
        ...(options.force ? { force: true } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatRefreshModels(response));
    });

  const profilesCommand = modelsCommand
    .command("profiles")
    .description("Get or set Router model profiles");

  profilesCommand
    .command("get")
    .description("Get model profiles document")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      const doc = await client.getModelProfiles();
      if (options.json) {
        console.log(JSON.stringify(doc, null, 2));
        return;
      }
      console.log(formatModelProfiles(doc));
    });

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
      const { client } = await connectLocalEngine(env);
      const updated = await client.putModelProfiles(doc);
      if (options.json) {
        console.log(JSON.stringify(updated, null, 2));
        return;
      }
      console.log(`Updated ${updated.profiles.length} model profile(s).`);
    });
}
