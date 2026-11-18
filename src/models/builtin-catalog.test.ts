import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  type BuiltinModelRef,
  builtinCatalog,
  matchBuiltinModels,
  normalizeId,
  refOf,
} from "./builtin-catalog.ts";

const ref = (
  provider: string,
  id: string,
  api = "openai-completions",
  name = id,
): BuiltinModelRef => ({
  provider,
  id,
  name,
  api,
  reasoning: false,
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costTiers: false,
});

const catalog = [
  ref("openrouter", "anthropic/claude-sonnet-4.5", "openai-completions", "Claude Sonnet 4.5"),
  ref("anthropic", "claude-sonnet-4-5", "anthropic-messages", "Claude Sonnet 4.5"),
  ref("bedrock", "claude-sonnet-4-5", "bedrock-converse-stream", "Claude Sonnet 4.5"),
  ref("anthropic", "claude-opus-4-1", "anthropic-messages", "Claude Opus 4.1"),
  ref("openai", "gpt-5", "openai-responses", "GPT-5"),
];

test("refOf 取出 models.json 能复制的字段，并标出分档价格；builtinCatalog 是 pi-ai 自带的目录", () => {
  const { provider } = fauxProvider({
    provider: "gw",
    models: [
      {
        id: "vision",
        name: "Vision",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 32_000,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    ],
  });
  const model = provider.getModels()[0];
  assert.ok(model);
  assert.deepEqual(refOf("gw", model), {
    provider: "gw",
    id: "vision",
    name: "Vision",
    api: model.api,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    costTiers: false,
  });
  const tiered = { ...model.cost, tiers: [{ ...model.cost, inputTokensAbove: 200_000 }] };
  assert.equal(refOf("gw", { ...model, cost: tiered }).costTiers, true);

  const sonnet = builtinCatalog().find(
    (m) => m.provider === "anthropic" && m.id === "claude-sonnet-4-5",
  );
  assert.equal(sonnet?.api, "anthropic-messages");
});

test("normalizeId 去掉厂商前缀，忽略大小写和分隔符，保留版本", () => {
  assert.equal(normalizeId("anthropic/Claude_Sonnet.4.5"), "claude-sonnet-4-5");
  assert.equal(normalizeId("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5-20250929");
});

test("先列 id 完全相同的，再列规范化后相同的，再列模糊匹配的；同组里调用方的 API 优先", () => {
  const ids = (query: string, api?: string) =>
    matchBuiltinModels(catalog, query, api).map((m) => `${m.provider}/${m.id}`);
  assert.deepEqual(ids("claude-sonnet-4-5", "bedrock-converse-stream"), [
    "bedrock/claude-sonnet-4-5",
    "anthropic/claude-sonnet-4-5",
    "openrouter/anthropic/claude-sonnet-4.5",
    // "claude-sonnet-4-5" is not a subsequence of the opus id, so only the three Sonnet entries match.
  ]);
  assert.deepEqual(ids("Claude-Sonnet-4.5", "openai-completions").slice(0, 3), [
    "openrouter/anthropic/claude-sonnet-4.5",
    "anthropic/claude-sonnet-4-5",
    "bedrock/claude-sonnet-4-5",
  ]);
  assert.deepEqual(ids("opus"), ["anthropic/claude-opus-4-1"]);
  assert.deepEqual(ids("gpt 5"), ["openai/gpt-5"]);
  assert.deepEqual(ids("  "), []);
  assert.equal(matchBuiltinModels(catalog, "claude", undefined, 2).length, 2);
});
