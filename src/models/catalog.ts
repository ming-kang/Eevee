import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { formatModel, type ModelDefaults } from "../contracts/index.ts";

export type CatalogInput = {
  models: Models;
  defaults: ModelDefaults;
  profiles: string | undefined;
};

/** What `models://` and `eevee model list` show: defaults, usable models with their key figures, and profiles. */
export async function renderCatalog(input: CatalogInput): Promise<string> {
  const defaults = Object.entries(input.defaults).flatMap(([role, choice]) =>
    choice === undefined ? [] : [`- ${role}：${formatModel(choice)}`],
  );
  const available = await input.models.getAvailable().catch(() => []);
  return [
    "## 默认模型",
    defaults.join("\n") || "（未设置）",
    "## 可用模型",
    available.map(describeModel).join("\n") || "（没有已配置凭据的 provider）",
    "## 使用经验（~/.eevee/models.md）",
    input.profiles?.trim() || "（还没有记录）",
  ].join("\n\n");
}

export function describeModel(model: Model<Api>): string {
  const parts = [`上下文 ${compact(model.contextWindow)}`];
  const { cost } = model;
  if (cost.input || cost.output) parts.push(`输入 $${cost.input}/M`, `输出 $${cost.output}/M`);
  if (cost.cacheRead) parts.push(`缓存读 $${cost.cacheRead}/M`);
  if (model.promptCache?.short) parts.push(`缓存 ${duration(model.promptCache.short)}`);
  if (model.reasoning) parts.push("推理");
  return `- ${model.provider}/${model.id}（${model.name}）：${parts.join(" · ")}`;
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
