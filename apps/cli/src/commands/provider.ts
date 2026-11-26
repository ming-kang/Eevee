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
  installSignalAbort,
  parseIntRangeFlag,
  parseKeyValueFlags,
} from "../args.ts";
import {
  formatProbeResult,
  formatProviderCatalog,
  formatProviderDetail,
  formatProviders,
  formatSmokeTestResult,
} from "../format.ts";

function parseNonEmptyId(raw: string, label: string): string {
  if (raw.trim().length === 0) {
    throw new Error(`Invalid ${label}: must not be empty`);
  }
  return raw;
}

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

export function registerProviderCommands(program: Command, env: NodeJS.ProcessEnv): void {
  const providerCommand = program
    .command("provider")
    .description("Manage configured and custom model providers");

  providerCommand
    .command("list")
    .description("List configured providers or the built-in provider catalog")
    .option("--catalog", "Show the built-in provider catalog and supported APIs")
    .option("--json", "Output JSON")
    .action(async (options: { catalog?: boolean; json?: boolean }) => {
      const { client } = await connectLocalEngine(env);
      if (options.catalog) {
        const response = await client.getProviderCatalog();
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(formatProviderCatalog(response));
        return;
      }
      const response = await client.listProviders();
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatProviders(response));
    });

  providerCommand
    .command("show")
    .description("Show detailed configuration and models for a provider")
    .argument("<providerId>", "Provider ID")
    .option("--json", "Output JSON")
    .action(async (rawProviderId: string, options: { json?: boolean }) => {
      const providerId = parseNonEmptyId(rawProviderId, "providerId");
      const { client } = await connectLocalEngine(env);
      const response = await client.getProviderDetail(providerId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(formatProviderDetail(response.provider));
    });

  providerCommand
    .command("add")
    .description("Create a custom provider or override configuration")
    .argument("<providerId>", "Provider ID")
    .option("--name <name>", "Display name")
    .option("--api <api>", "Provider wire API (e.g. openai-responses, openai-completions)")
    .option("--base-url <url>", "Provider base URL")
    .option("--api-key <keyOrRef>", "API key, $ENV_VAR, or !shell command")
    .option("--auth-header", "Send API key as Authorization: Bearer header")
    .option("--header <KEY=VALUE...>", "Custom HTTP headers (KEY=VALUE)", collectRepeatedFlag)
    .option("--probe-import", "Probe endpoint and import discovered models after creation")
    .option("--json", "Output JSON")
    .action(
      async (
        rawProviderId: string,
        options: {
          name?: string;
          api?: string;
          baseUrl?: string;
          apiKey?: string;
          authHeader?: boolean;
          header?: string[];
          probeImport?: boolean;
          json?: boolean;
        },
      ) => {
        const providerId = parseNonEmptyId(rawProviderId, "providerId");
        const headers = parseKeyValueFlags(options.header, "--header");
        const input: UpsertProviderRequest = {
          id: providerId,
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.api === undefined ? {} : { api: options.api }),
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
          ...(options.authHeader ? { authHeader: true } : {}),
          ...(headers === undefined ? {} : { headers }),
        };

        const { client } = await connectLocalEngine(env);
        const created = await client.createProvider(input);
        if (!options.probeImport) {
          if (options.json) {
            console.log(JSON.stringify(created, null, 2));
            return;
          }
          console.log(formatProviderDetail(created.provider));
          return;
        }

        const controller = new AbortController();
        const cleanup = installSignalAbort(controller);
        try {
          const probe = await client.probeProvider(providerId, {}, controller.signal);
          let importedResult: ImportProviderModelsResponse | undefined;
          if (probe.ok && probe.models.length > 0) {
            importedResult = await client.importProviderModels(
              providerId,
              { models: probe.models.map(toImportModelItem) },
              controller.signal,
            );
          }

          const provider = importedResult?.provider ?? created.provider;
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  provider,
                  probe,
                  imported: importedResult?.imported ?? 0,
                },
                null,
                2,
              ),
            );
          } else {
            console.log(formatProviderDetail(provider));
            console.log("");
            console.log(formatProbeResult(probe));
          }
          if (!probe.ok) {
            process.exitCode = 1;
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          cleanup();
        }
      },
    );

  providerCommand
    .command("update")
    .description("Update an existing provider or built-in override in models.json")
    .argument("<providerId>", "Provider ID")
    .option("--name <name>", "Display name")
    .option("--api <api>", "Provider wire API")
    .option("--base-url <url>", "Provider base URL")
    .option("--api-key <keyOrRef>", "API key, $ENV_VAR, or !shell command")
    .option("--auth-header", "Send API key as Authorization: Bearer header")
    .option("--no-auth-header", "Disable sending API key as Authorization: Bearer header")
    .option("--header <KEY=VALUE...>", "Custom HTTP headers (KEY=VALUE)", collectRepeatedFlag)
    .option("--json", "Output JSON")
    .action(
      async (
        rawProviderId: string,
        options: {
          name?: string;
          api?: string;
          baseUrl?: string;
          apiKey?: string;
          authHeader?: boolean;
          header?: string[];
          json?: boolean;
        },
      ) => {
        const providerId = parseNonEmptyId(rawProviderId, "providerId");
        const headers = parseKeyValueFlags(options.header, "--header");
        const patch: UpsertProviderRequest = {
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.api === undefined ? {} : { api: options.api }),
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
          ...(options.authHeader === undefined ? {} : { authHeader: options.authHeader }),
          ...(headers === undefined ? {} : { headers }),
        };
        if (Object.keys(patch).length === 0) {
          throw new Error("Specify at least one field to update.");
        }

        const { client } = await connectLocalEngine(env);
        const response = await client.updateProvider(providerId, patch);
        if (options.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(formatProviderDetail(response.provider));
      },
    );

  providerCommand
    .command("remove")
    .description("Remove a custom provider or built-in provider override from models.json")
    .argument("<providerId>", "Provider ID")
    .option("--json", "Output JSON")
    .action(async (rawProviderId: string, options: { json?: boolean }) => {
      const providerId = parseNonEmptyId(rawProviderId, "providerId");
      const { client } = await connectLocalEngine(env);
      const response = await client.deleteProvider(providerId);
      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }
      console.log(`Removed provider ${providerId}`);
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
        const providerId = parseNonEmptyId(rawProviderId, "providerId");
        const input: ProbeProviderRequest = {
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.api === undefined ? {} : { api: options.api }),
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        };

        const { client } = await connectLocalEngine(env);
        const controller = new AbortController();
        const cleanup = installSignalAbort(controller);
        try {
          const probe = await client.probeProvider(providerId, input, controller.signal);
          let importedResult: ImportProviderModelsResponse | undefined;
          if (options.import && probe.ok) {
            const newModels = probe.models.filter((model) => !model.exists).map(toImportModelItem);
            if (newModels.length > 0) {
              importedResult = await client.importProviderModels(
                providerId,
                { models: newModels },
                controller.signal,
              );
            }
          }

          if (options.json) {
            console.log(
              JSON.stringify(
                options.import
                  ? {
                      ...probe,
                      imported: importedResult?.imported ?? 0,
                      ...(importedResult === undefined
                        ? {}
                        : { provider: importedResult.provider }),
                    }
                  : probe,
                null,
                2,
              ),
            );
            return;
          }

          console.log(formatProbeResult(probe));
          if (options.import && probe.ok) {
            console.log(
              importedResult === undefined
                ? "No new models to import."
                : `Imported ${importedResult.imported} new model(s).`,
            );
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          cleanup();
        }
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
        options: {
          thinking?: string;
          tools?: boolean;
          timeout?: string;
          json?: boolean;
        },
      ) => {
        const providerId = parseNonEmptyId(rawProviderId, "providerId");
        const modelId = parseNonEmptyId(rawModelId, "modelId");
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
        const controller = new AbortController();
        const cleanup = installSignalAbort(controller);
        try {
          const result = await client.testProviderModel(
            providerId,
            modelId,
            input,
            controller.signal,
          );
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(formatSmokeTestResult(result));
          }
          if (!result.ok) {
            process.exitCode = 1;
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          cleanup();
        }
      },
    );
}
