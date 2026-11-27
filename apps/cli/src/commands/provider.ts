import { connectLocalEngine } from "@eevee/engine";
import {
  type ImportProviderModelsRequest,
  type ImportProviderModelsResponse,
  type ProbedModel,
  type ProbeProviderRequest,
  parseWithSchema,
  type SmokeTestModelRequest,
  ThinkingLevelSchema,
  type UpsertProviderRequest,
} from "@eevee/protocol";
import type { Command } from "commander";
import {
  collectRepeatedFlag,
  parseIntRangeFlag,
  parseKeyValueFlags,
  parseNonEmpty,
} from "../args.ts";
import { printResult, runEngineCommand, withSignalAbort } from "../command-helpers.ts";
import {
  formatProbeResult,
  formatProviderCatalog,
  formatProviderDetail,
  formatProviders,
  formatSmokeTestResult,
} from "../format.ts";

type ProviderUpsertOptions = {
  name?: string;
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  authHeader?: boolean;
  header?: string[];
  json?: boolean;
};

function toImportModelItem(model: ProbedModel): ImportProviderModelsRequest["models"][number] {
  return {
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.input === undefined ? {} : { input: [...model.input] }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
  };
}

function buildProviderUpsertInput(
  options: ProviderUpsertOptions,
  id?: string,
): UpsertProviderRequest {
  const headers = parseKeyValueFlags(options.header, "--header");
  return {
    ...(id === undefined ? {} : { id }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.api === undefined ? {} : { api: options.api }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.authHeader === undefined ? {} : { authHeader: options.authHeader }),
    ...(headers === undefined ? {} : { headers }),
  };
}

function addProviderFields(cmd: Command): Command {
  return cmd
    .argument("<providerId>", "Provider ID")
    .option("--name <name>", "Display name")
    .option("--api <api>", "Provider wire API (e.g. openai-responses, openai-completions)")
    .option("--base-url <url>", "Provider base URL")
    .option("--api-key <keyOrRef>", "API key, $ENV_VAR, or !shell command")
    .option("--auth-header", "Send API key as Authorization: Bearer header")
    .option("--header <KEY=VALUE...>", "Custom HTTP headers (KEY=VALUE)", collectRepeatedFlag);
}

export function registerProviderCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const providerCommand = program
    .command("provider")
    .description("Manage configured and custom model providers");

  providerCommand
    .command("list")
    .description("List configured providers or the built-in provider catalog")
    .option("--catalog", "Show the built-in provider catalog and supported APIs")
    .option("--json", "Output JSON")
    .action((options: { catalog?: boolean; json?: boolean }) =>
      options.catalog
        ? runEngineCommand(env, options, (c) => c.getProviderCatalog(), formatProviderCatalog)
        : runEngineCommand(env, options, (c) => c.listProviders(), formatProviders),
    );

  providerCommand
    .command("show")
    .description("Show detailed configuration and models for a provider")
    .argument("<providerId>", "Provider ID")
    .option("--json", "Output JSON")
    .action(async (rawProviderId: string, options: { json?: boolean }) => {
      const providerId = parseNonEmpty(rawProviderId, "providerId");
      await runEngineCommand(
        env,
        options,
        (c) => c.getProviderDetail(providerId),
        (r) => formatProviderDetail(r.provider),
      );
    });

  const addCmd = addProviderFields(
    providerCommand
      .command("add")
      .description("Create a custom provider or override configuration"),
  );
  addCmd
    .option("--probe-import", "Probe endpoint and import discovered models after creation")
    .option("--json", "Output JSON")
    .action(
      async (rawProviderId: string, options: ProviderUpsertOptions & { probeImport?: boolean }) => {
        const providerId = parseNonEmpty(rawProviderId, "providerId");
        const input = buildProviderUpsertInput(
          { ...options, authHeader: options.authHeader ? true : undefined },
          providerId,
        );
        if (!options.probeImport) {
          await runEngineCommand(
            env,
            options,
            (c) => c.createProvider(input),
            (r) => formatProviderDetail(r.provider),
          );
          return;
        }
        const { client } = await connectLocalEngine(env);
        const created = await client.createProvider(input);
        await withSignalAbort(async (signal) => {
          const probe = await client.probeProvider(providerId, {}, signal);
          const importedResult =
            probe.ok && probe.models.length > 0
              ? await client.importProviderModels(
                  providerId,
                  { models: probe.models.map(toImportModelItem) },
                  signal,
                )
              : undefined;
          const provider = importedResult?.provider ?? created.provider;
          printResult(
            { provider, probe, imported: importedResult?.imported ?? 0 },
            options,
            (res) => `${formatProviderDetail(res.provider)}\n\n${formatProbeResult(res.probe)}`,
          );
          if (!probe.ok) process.exitCode = 1;
        });
      },
    );

  const updateCmd = addProviderFields(
    providerCommand
      .command("update")
      .description("Update an existing provider or built-in override in models.json"),
  );
  updateCmd
    .option("--no-auth-header", "Disable sending API key as Authorization: Bearer header")
    .option("--json", "Output JSON")
    .action(async (rawProviderId: string, options: ProviderUpsertOptions) => {
      const providerId = parseNonEmpty(rawProviderId, "providerId");
      const patch = buildProviderUpsertInput(options);
      if (Object.keys(patch).length === 0) {
        throw new Error("Specify at least one field to update.");
      }
      await runEngineCommand(
        env,
        options,
        (c) => c.updateProvider(providerId, patch),
        (r) => formatProviderDetail(r.provider),
      );
    });

  providerCommand
    .command("remove")
    .description("Remove a custom provider or built-in provider override from models.json")
    .argument("<providerId>", "Provider ID")
    .option("--json", "Output JSON")
    .action(async (rawProviderId: string, options: { json?: boolean }) => {
      const providerId = parseNonEmpty(rawProviderId, "providerId");
      await runEngineCommand(
        env,
        options,
        (c) => c.deleteProvider(providerId),
        () => `Removed provider ${providerId}`,
      );
    });

  providerCommand
    .command("probe")
    .description("Probe a provider's model catalog endpoint")
    .argument("<providerId>", "Provider ID")
    .option("--base-url <url>", "Override base URL for this probe")
    .option("--api <api>", "Override wire API for this probe")
    .option("--api-key <key>", "Override API key for this probe")
    .option("--import", "Import newly discovered models that do not already exist")
    .option("--json", "Output JSON")
    .action(
      async (
        rawProviderId: string,
        options: {
          baseUrl?: string;
          api?: string;
          apiKey?: string;
          import?: boolean;
          json?: boolean;
        },
      ) => {
        const providerId = parseNonEmpty(rawProviderId, "providerId");
        const input: ProbeProviderRequest = {
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.api === undefined ? {} : { api: options.api }),
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        };
        const { client } = await connectLocalEngine(env);
        await withSignalAbort(async (signal) => {
          const probe = await client.probeProvider(providerId, input, signal);
          let importedResult: ImportProviderModelsResponse | undefined;
          if (options.import && probe.ok) {
            const newModels = probe.models.filter((model) => !model.exists).map(toImportModelItem);
            if (newModels.length > 0) {
              importedResult = await client.importProviderModels(
                providerId,
                { models: newModels },
                signal,
              );
            }
          }
          const payload = options.import
            ? {
                ...probe,
                imported: importedResult?.imported ?? 0,
                ...(importedResult === undefined ? {} : { provider: importedResult.provider }),
              }
            : probe;
          printResult(payload, options, () => {
            const summary = formatProbeResult(probe);
            if (!(options.import && probe.ok)) return summary;
            const importLine =
              importedResult === undefined
                ? "No new models to import."
                : `Imported ${importedResult.imported} new model(s).`;
            return `${summary}\n${importLine}`;
          });
        });
      },
    );

  providerCommand
    .command("test")
    .description("Run a live smoke test against a provider model")
    .argument("<providerId>", "Provider ID")
    .argument("<modelId>", "Model ID")
    .option("--thinking <level>", "Thinking level: off, minimal, low, medium, high, xhigh, or max")
    .option("--tools", "Include a tool call check in the smoke test")
    .option("--timeout <ms>", "Timeout in milliseconds (1000..60000)")
    .option("--json", "Output JSON")
    .action(
      async (
        rawProviderId: string,
        rawModelId: string,
        options: { thinking?: string; tools?: boolean; timeout?: string; json?: boolean },
      ) => {
        const providerId = parseNonEmpty(rawProviderId, "providerId");
        const modelId = parseNonEmpty(rawModelId, "modelId");
        const thinkingLevel =
          options.thinking === undefined
            ? undefined
            : parseWithSchema(ThinkingLevelSchema, options.thinking, "--thinking");
        const timeoutMs =
          options.timeout === undefined
            ? undefined
            : parseIntRangeFlag(options.timeout, "--timeout", 1000, 60000);
        const input: SmokeTestModelRequest = {
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          ...(options.tools ? { testTools: true } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        };
        const { client } = await connectLocalEngine(env);
        await withSignalAbort(async (signal) => {
          const result = await client.testProviderModel(providerId, modelId, input, signal);
          printResult(result, options, formatSmokeTestResult);
          if (!result.ok) process.exitCode = 1;
        });
      },
    );
}
