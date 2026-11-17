import type { CredentialStore, Model, Models } from "@earendil-works/pi-ai";
import { formatModel, type ModelDefaults } from "../contracts/index.ts";

export type CatalogInput = {
  models: Models;
  credentials?: Pick<CredentialStore, "list">;
  defaults: ModelDefaults;
  profiles: string | undefined;
};

export async function renderCatalog(input: CatalogInput): Promise<string> {
  const defaults = Object.entries(input.defaults).flatMap(([role, choice]) =>
    choice === undefined ? [] : [`- ${role}：${formatModel(choice)}`],
  );
  const providers = new Set([
    ...((await input.credentials?.list()) ?? []).map((c) => c.providerId),
    ...Object.values(input.defaults).flatMap((c) => (c === undefined ? [] : [c.provider])),
  ]);
  const available = [...providers].flatMap((provider) =>
    input.models.getModels(provider).map(describeModel),
  );
  return [
    "## 默认模型",
    defaults.join("\n") || "（未设置）",
    "## 可用模型",
    available.join("\n") || "（没有已登录的 provider）",
    "## 使用经验（~/.eevee/models.md）",
    input.profiles?.trim() || "（还没有记录）",
  ].join("\n\n");
}

export function describeModel(model: Model<string>): string {
  const parts = [`上下文 ${compact(model.contextWindow)}`];
  const { cost } = model;
  if (cost.input || cost.output) parts.push(`输入 $${cost.input}/M`, `输出 $${cost.output}/M`);
  if (cost.cacheRead) parts.push(`缓存读 $${cost.cacheRead}/M`);
  if (model.reasoning) parts.push("推理");
  return `- ${model.provider}/${model.id}（${model.name}）：${parts.join(" · ")}`;
}

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
