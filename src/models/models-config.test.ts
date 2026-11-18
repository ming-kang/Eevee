import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { ConfigError, parseConfig } from "../shared/config.ts";
import { applyModelsConfig, ModelsConfigSchema } from "./models-config.ts";

function modelsWithFaux() {
  const models = createModels();
  models.setProvider(
    fauxProvider({ provider: "faux", models: [{ id: "brain", contextWindow: 1000 }] }).provider,
  );
  return models;
}

test("新增的 provider 可以选用，apiKey 从环境变量解析并按 authHeader 带上", async () => {
  process.env.EEVEE_TEST_KEY = "secret";
  const models = modelsWithFaux();
  const problems = applyModelsConfig(models, {
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "$EEVEE_TEST_KEY",
        authHeader: true,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: models.json references variables as ${NAME}
        headers: { "x-team": "${EEVEE_TEST_KEY}-team" },
        models: [{ id: "qwen3", contextWindow: 32768 }],
      },
    },
  });
  assert.deepEqual(problems, []);
  const model = models.getModel("local", "qwen3");
  assert.equal(model?.contextWindow, 32768);
  assert.equal(model?.baseUrl, "http://127.0.0.1:11434/v1");
  const auth = await models.getAuth("local");
  assert.equal(auth?.auth.apiKey, "secret");
  assert.equal(auth?.auth.headers?.Authorization, "Bearer secret");
  assert.equal(auth?.auth.headers?.["x-team"], "secret-team");
});

test("modelOverrides 只改指定字段，cost 逐字段合并", () => {
  const models = modelsWithFaux();
  const before = models.getModel("faux", "brain");
  applyModelsConfig(models, {
    providers: { faux: { modelOverrides: { brain: { contextWindow: 9999, cost: { input: 3 } } } } },
  });
  const after = models.getModel("faux", "brain");
  assert.equal(after?.contextWindow, 9999);
  assert.equal(after?.cost.input, 3);
  assert.equal(after?.cost.output, before?.cost.output);
  assert.equal(after?.maxTokens, before?.maxTokens);
});

test("一个 provider 配错只影响它自己", () => {
  const models = modelsWithFaux();
  const problems = applyModelsConfig(models, {
    providers: {
      broken: { models: [{ id: "x" }] },
      faux: { modelOverrides: { brain: { contextWindow: 42 } } },
    },
  });
  assert.deepEqual(problems, [
    { file: "models.json", entry: "broken", code: "needs_api", model: "x" },
  ]);
  assert.equal(models.getProvider("broken"), undefined);
  assert.equal(models.getModel("faux", "brain")?.contextWindow, 42);
});

test("格式不对的 models.json 给出具体位置", () => {
  assert.throws(
    () => parseConfig(ModelsConfigSchema, { providers: { a: { models: [{}] } } }, "models.json"),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.problems.every((p) => p.file === "models.json" && p.code === "schema"),
  );
});
