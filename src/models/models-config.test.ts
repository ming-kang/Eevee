import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { ModelsConfigSchema } from "../api/models-config.ts";
import { ConfigError, parseConfig } from "../shared/config.ts";
import { applyModelsConfig } from "./models-config.ts";

function modelsWithFaux() {
  const models = createModels();
  models.setProvider(
    fauxProvider({ provider: "faux", models: [{ id: "brain", contextWindow: 1000 }] }).provider,
  );
  return models;
}

test("a new provider becomes usable, its apiKey resolves from the environment and is sent per authHeader", async () => {
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

test("modelOverrides change only the named fields and merge cost field by field", () => {
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

test("a misconfigured provider affects only itself", () => {
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

test("a malformed models.json gives the exact location", () => {
  assert.throws(
    () => parseConfig(ModelsConfigSchema, { providers: { a: { models: [{}] } } }, "models.json"),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.problems.every((p) => p.file === "models.json" && p.code === "schema"),
  );
});
