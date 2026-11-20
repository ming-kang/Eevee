import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import {
  type ConfigProblem,
  formatModel,
  type ModelChoice,
  type ModelDefaults,
  pickModel,
} from "../../domain/index.ts";
import type { ModelProviderView, ModelSpecView, ModelsView } from "../../protocol/contract.ts";

export type CatalogInput = {
  models: Models;
  defaults: ModelDefaults;
  profiles: string | undefined;
};

export type ModelsViewInput = CatalogInput & {
  customProviders?: ReadonlySet<string>;
  builtinProviders?: ReadonlyMap<string, { baseUrl?: string }>;
  problems?: readonly ConfigProblem[];
};

function formatCatalog(
  defaultsMap: ModelDefaults,
  available: readonly Model<Api>[],
  profiles: string | undefined,
): string {
  const defaults = Object.entries(defaultsMap).flatMap(([role, choice]) =>
    choice === undefined ? [] : [`- ${role}: ${formatChoice(choice)}`],
  );
  return [
    "## Default models",
    defaults.join("\n") || "(not set)",
    "## Available models",
    available.map(describeModel).join("\n") || "(no provider has configured credentials)",
    "## Usage notes (~/.eevee/models.md)",
    profiles?.trim() || "(nothing recorded yet)",
  ].join("\n\n");
}

/** What `models://` and `GET /api/models` show: defaults, usable models with their key figures, and profiles. */
export async function renderCatalog(input: CatalogInput): Promise<string> {
  const available = await input.models.getAvailable().catch(() => []);
  return formatCatalog(input.defaults, available, input.profiles);
}

/** Structured view for `GET /api/models`, keeping `catalog` compatible with CLI output. */
export async function buildModelsView(input: ModelsViewInput): Promise<ModelsView> {
  const availableModels = await input.models.getAvailable().catch(() => []);
  const providers = await Promise.all(
    input.models.getProviders().map(async (provider): Promise<ModelProviderView> => {
      const check = await input.models.checkAuth(provider.id).catch(() => undefined);
      const builtinBaseUrl = input.builtinProviders?.get(provider.id)?.baseUrl;
      let modelCount = 0;
      try {
        modelCount = provider.getModels().length;
      } catch {
        modelCount = 0;
      }
      return {
        id: provider.id,
        name: provider.name,
        configured: check !== undefined,
        ...(check === undefined
          ? {}
          : {
              authType: check.type,
              ...(check.source === undefined ? {} : { source: check.source }),
            }),
        custom: input.customProviders?.has(provider.id) ?? false,
        builtIn: input.builtinProviders?.has(provider.id) ?? false,
        ...(builtinBaseUrl === undefined ? {} : { defaultBaseUrl: builtinBaseUrl }),
        modelCount,
      };
    }),
  );
  providers.sort((a, b) => Number(b.configured) - Number(a.configured) || a.id.localeCompare(b.id));

  const available: ModelSpecView[] = availableModels.map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevels(model),
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    ...(model.promptCache?.short === undefined
      ? {}
      : { cacheShortSeconds: model.promptCache.short }),
  }));
  const routerModel = pickModel("router", input.defaults);
  const profiles = input.profiles?.trim() ?? "";

  return {
    catalog: formatCatalog(input.defaults, availableModels, input.profiles),
    defaults: input.defaults,
    ...(routerModel === undefined ? {} : { routerModel }),
    providers,
    available,
    profiles,
    problems: input.problems ?? [],
  };
}

export function describeModel(model: Model<Api>): string {
  const parts = [`context ${compact(model.contextWindow)}`];
  const { cost } = model;
  if (cost.input || cost.output) parts.push(`input $${cost.input}/M`, `output $${cost.output}/M`);
  if (cost.cacheRead) parts.push(`cache read $${cost.cacheRead}/M`);
  if (model.promptCache?.short) parts.push(`cache ${duration(model.promptCache.short)}`);
  const levels = getSupportedThinkingLevels(model).filter((level) => level !== "off");
  if (levels.length > 0) parts.push(`thinking level ${levels.join(" / ")}`);
  return `- ${model.provider}/${model.id} (${model.name}): ${parts.join(" · ")}`;
}

function formatChoice(choice: ModelChoice): string {
  const thinking =
    choice.thinkingLevel === undefined ? "" : `, thinking level ${choice.thinkingLevel}`;
  return `${formatModel(choice)}${thinking}`;
}

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function duration(seconds: number): string {
  return seconds >= 3600 ? `${+(seconds / 3600).toFixed(1)}h` : `${Math.round(seconds / 60)}min`;
}
