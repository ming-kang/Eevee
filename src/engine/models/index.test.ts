import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { eeveePaths } from "../../shared/paths.ts";
import { createModelRuntime } from "./index.ts";

async function withRuntime(
  run: (runtime: Awaited<ReturnType<typeof createModelRuntime>>, file: string) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "eevee-models-"));
  const paths = eeveePaths(home);
  const runtime = await createModelRuntime(paths, {
    base: (credentials) => {
      const models = createModels({ credentials });
      models.setProvider(
        fauxProvider({ provider: "faux", models: [{ id: "brain" }, { id: "spare" }] }).provider,
      );
      return models;
    },
  });
  try {
    await run(runtime, paths.models);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
}

const local = {
  baseUrl: "http://127.0.0.1:11434/v1",
  api: "openai-completions",
  models: [{ id: "qwen3", contextWindow: 32768 }],
};

test("writing one provider changes only its own entry, keeps the rest untouched, and takes effect at once", async () => {
  await withRuntime(async (runtime, file) => {
    await writeFile(
      file,
      JSON.stringify({
        $schema: "./schema.json",
        providers: { faux: { modelOverrides: { brain: { contextWindow: 42 } } } },
      }),
    );
    await runtime.reload();
    assert.deepEqual(runtime.builtinProviders().get("faux"), {
      name: "faux",
      baseUrl: "http://localhost:0",
    });

    await runtime.setProviderConfig("local", local);
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.$schema, "./schema.json");
    assert.deepEqual(stored.providers.faux, { modelOverrides: { brain: { contextWindow: 42 } } });
    assert.deepEqual(stored.providers.local, local);
    assert.equal(runtime.models().getModel("local", "qwen3")?.contextWindow, 32768);
    assert.ok(runtime.customProviders().has("local"));
    assert.deepEqual(Object.keys(await runtime.providerConfigs()), ["faux", "local"]);

    await runtime.setProviderConfig("local", undefined);
    assert.equal(runtime.models().getProvider("local"), undefined);
    assert.deepEqual(Object.keys(await runtime.providerConfigs()), ["faux"]);
  });
});

test("entries that are not a provider or fail the schema are not written; the file is unchanged", async () => {
  await withRuntime(async (runtime, file) => {
    await assert.rejects(runtime.setProviderConfig("local", { ...local, models: [] }), {
      problem: {
        code: "bad_config",
        problems: [{ code: "needs_models", file: "models.json", entry: "local" }],
      },
    });
    await assert.rejects(
      runtime.setProviderConfig("local", { ...local, api: "no-such-api" }),
      (error: { problem: { code: string; problems: { code: string }[] } }) =>
        error.problem.code === "bad_config" &&
        error.problem.problems[0]?.code === "unsupported_api",
    );
    await assert.rejects(
      runtime.setProviderConfig("local", { ...local, contextWindow: 5 } as never),
      (error: { problem: { code: string; problems: { code: string; path: string }[] } }) =>
        error.problem.code === "bad_config" && error.problem.problems[0]?.code === "schema",
    );
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });

    await writeFile(file, "{ not json");
    await assert.rejects(
      runtime.setProviderConfig("local", local),
      (error: { problem: { code: string } }) => error.problem.code === "bad_config",
    );
    assert.equal(await readFile(file, "utf8"), "{ not json");
  });
});

test("a model used by a default cannot be deleted or renamed", async () => {
  await withRuntime(async (runtime) => {
    await runtime.setProviderConfig("local", local);
    await assert.rejects(
      runtime.setProviderConfig("local", { ...local, models: [{ id: "renamed" }] }, ["qwen3"]),
      { problem: { code: "model_in_use", provider: "local", modelId: "qwen3" } },
    );
    await assert.rejects(runtime.setProviderConfig("local", undefined, ["qwen3"]), {
      problem: { code: "model_in_use", provider: "local", modelId: "qwen3" },
    });
    const extra = { id: "extra", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1" };
    await runtime.setProviderConfig("faux", { models: [extra] });
    await assert.rejects(runtime.setProviderConfig("faux", undefined, ["extra"]), {
      problem: { code: "model_in_use", provider: "faux", modelId: "extra" },
    });
    await runtime.setProviderConfig("faux", undefined, ["brain"]);
    assert.equal(runtime.models().getModel("faux", "extra"), undefined);
    assert.ok(runtime.models().getModel("local", "qwen3"));
  });
});
