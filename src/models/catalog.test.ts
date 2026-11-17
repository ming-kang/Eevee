import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { eeveePaths } from "../shared/paths.ts";
import { buildModelsView } from "./catalog.ts";
import { createModelRuntime } from "./index.ts";

test("buildModelsView 返回角色默认模型、Router 生效模型、凭据状态、可用模型与兼容目录", async () => {
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
      worker: { provider: "configured", modelId: "deep" },
    },
    profiles: "# 使用经验\n\n- deep 适合复杂任务\n",
    customProviders: new Set(["configured"]),
    problems: ["测试警告"],
  });

  assert.deepEqual(view.routerModel, { provider: "configured", modelId: "fast" });
  assert.deepEqual(view.defaults.worker, { provider: "configured", modelId: "deep" });
  assert.deepEqual(view.problems, ["测试警告"]);
  assert.equal(view.profiles, "# 使用经验\n\n- deep 适合复杂任务");

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
  assert.equal(view.available[1]?.contextWindow, 200_000);
  assert.match(view.catalog, /configured\/fast/);
  assert.match(view.catalog, /deep 适合复杂任务/);

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

test("createModelRuntime + buildModelsView 暴露 models.json 自定义 provider 凭据与错误", async () => {
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
      view.problems.some((p) => p.includes("broken-local")),
      true,
    );
  } finally {
    if (prevKey === undefined) delete process.env.EEVEE_CATALOG_TEST_KEY;
    else process.env.EEVEE_CATALOG_TEST_KEY = prevKey;
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
