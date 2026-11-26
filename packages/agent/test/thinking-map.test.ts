import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import {
  ALL_THINKING_LEVELS,
  composeProviders,
  decodeThinkingLevelConfig,
  encodeThinkingLevelConfig,
  normalizeThinkingLevelMapForRuntime,
  parseModelsConfig,
  type ThinkingLevelConfig,
} from "../src/models/index.ts";

function configFromMap(map: ThinkingLevelMap | undefined): ThinkingLevelConfig {
  return decodeThinkingLevelConfig(map);
}

test("decodeThinkingLevelConfig covers all seven levels and inheritance", () => {
  const effective = {
    off: null,
    minimal: "min",
    low: "low",
    medium: null,
    high: "xhigh",
    xhigh: "xhigh",
    max: "ultimate",
  } satisfies ThinkingLevelMap;
  const own = { minimal: "min", high: "xhigh", max: "ultimate" } satisfies ThinkingLevelMap;
  const decoded = decodeThinkingLevelConfig(effective, { off: null, low: "low" }, own);
  assert.deepEqual(ALL_THINKING_LEVELS, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(decoded.off, { enabled: false, inherited: true });
  assert.deepEqual(decoded.minimal, { enabled: true, mappedTo: "min", inherited: false });
  assert.deepEqual(decoded.low, { enabled: true, inherited: true });
  assert.deepEqual(decoded.medium, { enabled: false, inherited: true });
  assert.deepEqual(decoded.high, { enabled: true, mappedTo: "xhigh", inherited: false });
  assert.deepEqual(decoded.xhigh, { enabled: true, inherited: true });
  assert.deepEqual(decoded.max, { enabled: true, mappedTo: "ultimate", inherited: false });
});

test("decodeThinkingLevelConfig treats extended levels as opt-in", () => {
  const decoded = configFromMap({ xhigh: null, max: "max" });
  assert.equal(decoded.off.enabled, true);
  assert.equal(decoded.minimal.enabled, true);
  assert.equal(decoded.xhigh.enabled, false);
  assert.equal(decoded.max.enabled, true);
  assert.equal(decoded.max.mappedTo, undefined);
});

test("encodeThinkingLevelConfig emits a minimal custom-model map", () => {
  const config = configFromMap(undefined);
  assert.equal(encodeThinkingLevelConfig(config), undefined);
  config.xhigh = { enabled: true };
  config.max = { enabled: true, mappedTo: "  ultimate  " };
  config.off = { enabled: false };
  config.low = { enabled: true, mappedTo: " custom-low " };
  assert.deepEqual(encodeThinkingLevelConfig(config), {
    off: null,
    low: "custom-low",
    xhigh: "xhigh",
    max: "ultimate",
  });
});

test("encodeThinkingLevelConfig reverses builtin nulls and removes redundant overrides", () => {
  const builtin = {
    off: null,
    minimal: null,
    low: "low",
    medium: "custom",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  } satisfies ThinkingLevelMap;
  const config = decodeThinkingLevelConfig(builtin, builtin, builtin);
  assert.equal(encodeThinkingLevelConfig(config, { builtinMap: builtin }), undefined);

  config.off = { enabled: true };
  config.minimal = { enabled: true };
  config.low = { enabled: false };
  config.medium = { enabled: true };
  config.high = { enabled: true, mappedTo: "xhigh" };
  config.xhigh = { enabled: false };
  config.max = { enabled: true };
  assert.deepEqual(encodeThinkingLevelConfig(config, { builtinMap: builtin }), {
    off: "",
    minimal: "minimal",
    low: null,
    medium: "medium",
    high: "xhigh",
    xhigh: null,
  });
});

test("OpenAI Responses off never encodes as literal off", () => {
  for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"]) {
    const config = configFromMap({ off: null });
    config.off = { enabled: true };
    assert.deepEqual(encodeThinkingLevelConfig(config, { builtinMap: { off: null }, api }), {
      off: "none",
    });
    config.off = { enabled: true, mappedTo: "off" };
    assert.deepEqual(encodeThinkingLevelConfig(config, { api }), { off: "none" });
  }
  const anthropic = configFromMap({ off: null });
  anthropic.off = { enabled: true };
  assert.deepEqual(
    encodeThinkingLevelConfig(anthropic, {
      builtinMap: { off: null },
      api: "anthropic-messages",
    }),
    { off: "" },
  );
});

test("off empty sentinel clears a builtin null during composition", () => {
  assert.deepEqual(normalizeThinkingLevelMapForRuntime({ off: null, high: "high" }, { off: "" }), {
    high: "high",
  });
  const providers = composeProviders(
    parseModelsConfig(
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://localhost:1/v1",
            api: "openai-completions",
            models: [{ id: "m", reasoning: true, thinkingLevelMap: { off: null } }],
            modelOverrides: { m: { thinkingLevelMap: { off: "" } } },
          },
        },
      }),
    ),
    { env: {} },
  );
  const model = providers.find((provider) => provider.id === "local")?.getModels()[0];
  assert.ok(model);
  assert.equal(model.thinkingLevelMap?.off, undefined);
});

test("encode, compose normalization, and decode round-trip effective rules", () => {
  const builtin = {
    off: null,
    minimal: "min",
    low: null,
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  } satisfies ThinkingLevelMap;
  const desired = decodeThinkingLevelConfig(builtin);
  desired.off = { enabled: true };
  desired.minimal = { enabled: true };
  desired.low = { enabled: true, mappedTo: "custom-low" };
  desired.medium = { enabled: false };
  desired.high = { enabled: true };
  desired.xhigh = { enabled: true, mappedTo: "extreme" };
  desired.max = { enabled: true };
  const override = encodeThinkingLevelConfig(desired, {
    builtinMap: builtin,
    api: "anthropic-messages",
  });
  const effective = normalizeThinkingLevelMapForRuntime(builtin, override);
  assert.deepEqual(decodeThinkingLevelConfig(effective), desired);
});
