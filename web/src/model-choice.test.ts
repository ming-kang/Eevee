import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSpecView } from "@shared/api/contract.ts";
import { clampLevel, groupModels, levelLabel, levelsOf, switchModel } from "./model-choice.ts";

const spec = (provider: string, modelId: string, levels: ModelSpecView["thinkingLevels"]) =>
  ({
    provider,
    modelId,
    name: modelId.toUpperCase(),
    contextWindow: 200_000,
    maxTokens: 8_000,
    reasoning: levels.length > 1,
    thinkingLevels: levels,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }) satisfies ModelSpecView;

const deep = spec("faux", "deep", ["off", "minimal", "low", "medium", "high"]);
const fast = spec("faux", "fast", ["off"]);
const max = spec("other", "max", ["off", "low", "high", "xhigh", "max"]);

test("levelsOf takes this model's levels from the catalog, only off when it isn't there", () => {
  assert.deepEqual(
    levelsOf([deep, fast], { provider: "faux", modelId: "deep" }),
    deep.thinkingLevels,
  );
  assert.deepEqual(levelsOf([deep, fast], { provider: "faux", modelId: "gone" }), ["off"]);
  assert.deepEqual(levelsOf([deep], undefined), ["off"]);
});

test("clampLevel keeps the same level, else searches up, then down", () => {
  assert.equal(clampLevel(deep.thinkingLevels, "medium"), "medium");
  assert.equal(clampLevel(max.thinkingLevels, "medium"), "high");
  assert.equal(clampLevel(deep.thinkingLevels, "max"), "high");
  assert.equal(clampLevel(fast.thinkingLevels, "high"), "off");
});

test("switchModel keeps the thinking level when it can", () => {
  const current = { provider: "faux", modelId: "deep", thinkingLevel: "medium" } as const;
  assert.deepEqual(switchModel(current, max), {
    provider: "other",
    modelId: "max",
    thinkingLevel: "high",
  });
  // A model that does not think drops the level instead of storing `off`.
  assert.deepEqual(switchModel(current, fast), { provider: "faux", modelId: "fast" });
  assert.deepEqual(switchModel(undefined, deep), { provider: "faux", modelId: "deep" });
});

test("groupModels groups by provider, searching id and name", () => {
  assert.deepEqual(
    groupModels([deep, fast, max], "").map(([provider, models]) => [
      provider,
      models.map((m) => m.modelId),
    ]),
    [
      ["faux", ["deep", "fast"]],
      ["other", ["max"]],
    ],
  );
  assert.deepEqual(
    groupModels([deep, fast, max], " FAST ").map(([, models]) => models.map((m) => m.modelId)),
    [["fast"]],
  );
  assert.deepEqual(groupModels([deep, fast, max], "other/m").length, 1);
});

test("levelLabel writes the levels in English", () => {
  assert.deepEqual(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) =>
      levelLabel(level as Parameters<typeof levelLabel>[0]),
    ),
    ["Off", "Minimal", "Low", "Medium", "High", "X-High", "Max"],
  );
});
