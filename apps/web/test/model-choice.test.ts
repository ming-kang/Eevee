import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "@eevee/protocol";
import {
  groupModelsByProvider,
  hasSelectableThinkingLevels,
  resolvePinnedModels,
  selectModelWithThinking,
  supportedThinkingLevelsOf,
  switchModelChoice,
  thinkingLevelsOfModel,
  togglePinnedKey,
  withThinkingLevel,
} from "../src/lib/model-choice.ts";

const MODELS: readonly ModelInfo[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    api: "anthropic-messages",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    available: true,
    supportedThinkingLevels: ["off", "low", "medium", "high"],
  },
  {
    provider: "openai",
    id: "gpt-4o",
    name: "GPT-4o",
    api: "openai-responses",
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
    available: true,
    supportedThinkingLevels: ["off"],
  },
  {
    provider: "openai",
    id: "o3",
    name: "OpenAI o3",
    api: "openai-responses",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 100_000,
    cost: { input: 10, output: 40, cacheRead: 2.5, cacheWrite: 0 },
    available: true,
    supportedThinkingLevels: ["low", "medium", "high"],
  },
];

test("groupModelsByProvider filters and sorts models by provider and name", () => {
  const all = groupModelsByProvider(MODELS, "");
  assert.deepEqual(
    all.map(([p, list]) => [p, list.map((m) => m.id)]),
    [
      ["anthropic", ["claude-sonnet-4"]],
      ["openai", ["gpt-4o", "o3"]],
    ],
  );

  const filtered = groupModelsByProvider(MODELS, "sonnet");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.[1][0]?.id, "claude-sonnet-4");
});

test("switchModelChoice preserves compatible thinking level and drops unsupported levels", () => {
  const [claude, gpt4o, o3] = MODELS;
  assert.ok(claude && gpt4o && o3);

  assert.deepEqual(
    supportedThinkingLevelsOf(MODELS, { provider: "anthropic", modelId: "claude-sonnet-4" }),
    ["off", "low", "medium", "high"],
  );
  assert.deepEqual(
    supportedThinkingLevelsOf(MODELS, { provider: "openai", modelId: "gpt-4o" }),
    [],
  );

  const fromClaudeHigh = withThinkingLevel(
    { provider: "anthropic", modelId: "claude-sonnet-4" },
    "high",
  );
  assert.deepEqual(switchModelChoice(fromClaudeHigh, o3), {
    provider: "openai",
    modelId: "o3",
    thinkingLevel: "high",
  });
  assert.deepEqual(switchModelChoice(fromClaudeHigh, gpt4o), {
    provider: "openai",
    modelId: "gpt-4o",
  });

  const fromClaudeOff = withThinkingLevel(
    { provider: "anthropic", modelId: "claude-sonnet-4" },
    "off",
  );
  assert.deepEqual(switchModelChoice(fromClaudeOff, o3), {
    provider: "openai",
    modelId: "o3",
    thinkingLevel: "low",
  });

  assert.deepEqual(withThinkingLevel(fromClaudeHigh, undefined), {
    provider: "anthropic",
    modelId: "claude-sonnet-4",
  });
  assert.deepEqual(switchModelChoice(undefined, claude), {
    provider: "anthropic",
    modelId: "claude-sonnet-4",
    thinkingLevel: "off",
  });

  assert.equal(hasSelectableThinkingLevels(o3), true);
  assert.equal(hasSelectableThinkingLevels(claude), true);
  assert.equal(hasSelectableThinkingLevels(gpt4o), false);
  assert.deepEqual(thinkingLevelsOfModel(o3), ["low", "medium", "high"]);
  assert.deepEqual(thinkingLevelsOfModel(gpt4o), ["off"]);
  assert.deepEqual(selectModelWithThinking(o3, "high"), {
    provider: "openai",
    modelId: "o3",
    thinkingLevel: "high",
  });
  assert.deepEqual(selectModelWithThinking(o3, undefined), {
    provider: "openai",
    modelId: "o3",
    thinkingLevel: "low",
  });
  assert.deepEqual(selectModelWithThinking(gpt4o, "high"), {
    provider: "openai",
    modelId: "gpt-4o",
  });
});

test("togglePinnedKey and resolvePinnedModels manage pinned ordering", () => {
  const pinned1 = togglePinnedKey([], "openai/o3");
  const pinned2 = togglePinnedKey(pinned1, "anthropic/claude-sonnet-4");
  assert.deepEqual(
    resolvePinnedModels(pinned2, MODELS).map((m) => m.id),
    ["o3", "claude-sonnet-4"],
  );
  assert.deepEqual(togglePinnedKey(pinned2, "openai/o3"), ["anthropic/claude-sonnet-4"]);
});
