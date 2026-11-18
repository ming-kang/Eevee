import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import type { ModelProviderView, ModelSpecView, ModelsView } from "../api/contract.ts";
import {
  formatModel,
  type ModelChoice,
  type ModelDefaults,
  pickModel,
} from "../contracts/index.ts";

export type CatalogInput = {
  models: Models;
  defaults: ModelDefaults;
  profiles: string | undefined;
};

export type ModelsViewInput = CatalogInput & {
  customProviders?: ReadonlySet<string>;
  problems?: readonly string[];
};

function formatCatalog(
  defaultsMap: ModelDefaults,
  available: readonly Model<Api>[],
  profiles: string | undefined,
): string {
  const defaults = Object.entries(defaultsMap).flatMap(([role, choice]) =>
    choice === undefined ? [] : [`- ${role}：${formatChoice(choice)}`],
  );
  return [
    "## 默认模型",
    defaults.join("\n") || "（未设置）",
    "## 可用模型",
    available.map(describeModel).join("\n") || "（没有已配置凭据的 provider）",
    "## 使用经验（~/.eevee/models.md）",
    profiles?.trim() || "（还没有记录）",
  ].join("\n\n");
}

/** What `models://` and `eevee model list` show: defaults, usable models with their key figures, and profiles. */
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
  const parts = [`上下文 ${compact(model.contextWindow)}`];
  const { cost } = model;
  if (cost.input || cost.output) parts.push(`输入 $${cost.input}/M`, `输出 $${cost.output}/M`);
  if (cost.cacheRead) parts.push(`缓存读 $${cost.cacheRead}/M`);
  if (model.promptCache?.short) parts.push(`缓存 ${duration(model.promptCache.short)}`);
  const levels = getSupportedThinkingLevels(model).filter((level) => level !== "off");
  if (levels.length > 0) parts.push(`思考档位 ${levels.join(" / ")}`);
  return `- ${model.provider}/${model.id}（${model.name}）：${parts.join(" · ")}`;
}

function formatChoice(choice: ModelChoice): string {
  const thinking = choice.thinkingLevel === undefined ? "" : `，思考档位 ${choice.thinkingLevel}`;
  return `${formatModel(choice)}${thinking}`;
}

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function duration(seconds: number): string {
  return seconds >= 3600
    ? `${+(seconds / 3600).toFixed(1)} 小时`
    : `${Math.round(seconds / 60)} 分钟`;
}
