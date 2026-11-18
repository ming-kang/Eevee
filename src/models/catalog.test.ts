import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { eeveePaths } from "../shared/paths.ts";
import { buildModelsView } from "./catalog.ts";
import { createModelRuntime } from "./index.ts";

test("buildModelsView returns role defaults, the effective Router model, credential state, available models and the compatibility catalog", async () => {
  const models = createModels();
  models.setProvider(
    fauxProvider({
      provider: "configured",
      models: [
        { id: "fast", name: "Fast", contextWindow: 128_000, reasoning: false },
        { id: "deep", name: "Deep", contextWindow: 200_000, reasoning: true },
      ],
    }).provider,
  );
  models.setProvider({
    ...fauxProvider({
      provider: "unconfigured",
      models: [{ id: "dormant" }],
    }).provider,
    auth: {
      apiKey: {
        name: "API key",
        login: async () => ({ type: "api_key", key: "unused" }),
        check: async () => undefined,
        resolve: async () => undefined,
      },
    },
  });

  const view = await buildModelsView({
    models,
    defaults: {
      default: { provider: "configured", modelId: "fast" },
      worker: { provider: "configured", modelId: "deep", thinkingLevel: "high" },
    },
    profiles: "# Usage notes\n\n- deep suits complex tasks\n",
    customProviders: new Set(["configured"]),
    problems: [{ file: "models.json", code: "failed", detail: "test warning" }],
  });

  assert.deepEqual(view.routerModel, { provider: "configured", modelId: "fast" });
  assert.deepEqual(view.defaults.worker, {
    provider: "configured",
    modelId: "deep",
    thinkingLevel: "high",
  });
  assert.deepEqual(view.problems, [
    { file: "models.json", code: "failed", detail: "test warning" },
  ]);
  assert.equal(view.profiles, "# Usage notes\n\n- deep suits complex tasks");

  assert.equal(view.providers.length, 2);
  assert.equal(view.providers[0]?.id, "configured");
  assert.equal(view.providers[0]?.configured, true);
  assert.equal(view.providers[0]?.custom, true);
  assert.equal(view.providers[0]?.modelCount, 2);
  assert.equal(view.providers[1]?.id, "unconfigured");
  assert.equal(view.providers[1]?.configured, false);
  assert.equal(view.providers[1]?.custom, false);

  assert.equal(view.available.length, 2);
  assert.equal(view.available[1]?.reasoning, true);
  assert.deepEqual(view.available[0]?.thinkingLevels, ["off"]);
  assert.deepEqual(view.available[1]?.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
  assert.match(view.catalog, /worker: configured\/deep, thinking level high/);
  assert.match(
    view.catalog,
    /configured\/deep \(Deep\):.*thinking level minimal \/ low \/ medium \/ high/,
  );
  assert.equal(view.available[1]?.contextWindow, 200_000);
  assert.match(view.catalog, /configured\/fast/);
  assert.match(view.catalog, /deep suits complex tasks/);

  const explicitRouter = await buildModelsView({
    models,
    defaults: {
      default: { provider: "configured", modelId: "fast" },
      router: { provider: "configured", modelId: "deep" },
    },
    profiles: undefined,
  });
  assert.deepEqual(explicitRouter.routerModel, { provider: "configured", modelId: "deep" });
});

test("createModelRuntime + buildModelsView expose models.json custom-provider credentials and errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "eevee-catalog-"));
  const prevKey = process.env.EEVEE_CATALOG_TEST_KEY;
  process.env.EEVEE_CATALOG_TEST_KEY = "test-secret";
  try {
    const paths = eeveePaths(home);
    await writeFile(
      paths.models,
      JSON.stringify({
        providers: {
          "custom-local": {
            name: "Local Test",
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            apiKey: "$EEVEE_CATALOG_TEST_KEY",
            models: [{ id: "qwen3", name: "Qwen 3", contextWindow: 32768 }],
          },
          "broken-local": {
            models: [{ id: "bad" }],
          },
        },
      }),
    );

    const runtime = await createModelRuntime(paths);
    const view = await buildModelsView({
      models: runtime.models(),
      defaults: { default: { provider: "custom-local", modelId: "qwen3" } },
      profiles: undefined,
      customProviders: runtime.customProviders(),
      problems: runtime.problems(),
    });

    const local = view.providers.find((p) => p.id === "custom-local");
    assert.equal(local?.configured, true);
    assert.equal(local?.custom, true);
    assert.equal(local?.authType, "api_key");
    assert.equal(local?.source, "models.json");
    assert.equal(local?.modelCount, 1);

    assert.equal(
      view.available.some((m) => m.provider === "custom-local" && m.modelId === "qwen3"),
      true,
    );
    assert.equal(
      view.problems.some((p) => p.entry === "broken-local"),
      true,
    );
  } finally {
    if (prevKey === undefined) delete process.env.EEVEE_CATALOG_TEST_KEY;
    else process.env.EEVEE_CATALOG_TEST_KEY = prevKey;
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
