import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deleteCustomModel,
  deleteModelOverride,
  deleteProviderConfig,
  mutateModelsJson,
  readModelsJsonDocument,
  upsertCustomModel,
  upsertModelOverride,
  upsertProviderConfig,
  writeModelsJsonFile,
} from "../src/models/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-models-json-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("models.json mutations preserve JSONC comments, BOM, CRLF, and trailing commas", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "models.json");
    const original = [
      "\ufeff{",
      "  // provider comment",
      '  "providers": {',
      '    "local": {',
      '      "baseUrl": "http://localhost:1/v1",',
      '      "api": "openai-completions",',
      '      "apiKey": "$OLD_KEY", // credential comment',
      '      "models": [',
      '        { "id": "one" },',
      "      ],",
      "    },",
      "  },",
      "}",
      "",
    ].join("\r\n");
    await writeFile(file, original);

    await upsertProviderConfig(file, "local", { name: "Local gateway", apiKey: null });
    const updated = await readFile(file, "utf8");
    assert.ok(updated.startsWith("\ufeff{"));
    assert.ok(updated.includes("// provider comment"));
    assert.ok(updated.includes("// credential comment"));
    assert.ok(updated.includes('"models": [\r\n'));
    assert.ok(updated.includes("      ],\r\n"));
    assert.ok(updated.includes('"name": "Local gateway"'));
    assert.ok(!updated.includes("OLD_KEY"));
    assert.equal(await readFile(`${file}.bak`, "utf8"), original);

    await upsertProviderConfig(file, "local", { name: "Renamed again" });
    assert.equal(await readFile(`${file}.bak`, "utf8"), original);
  });
});

test("models.json concurrent mutations retain every update", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "models.json");
    await upsertProviderConfig(file, "local", {
      baseUrl: "http://localhost:1/v1",
      api: "openai-completions",
      models: [{ id: "one" }],
    });
    await Promise.all([
      upsertProviderConfig(file, "local", { name: "Local" }),
      upsertProviderConfig(file, "local", { headers: { "X-Test": "yes" } }),
      upsertCustomModel(file, "local", { id: "two", contextWindow: 2000 }),
    ]);
    const document = await readModelsJsonDocument(file);
    const local = document.config.providers.local;
    assert.ok(local);
    assert.equal(local.name, "Local");
    assert.deepEqual(local.headers, { "X-Test": "yes" });
    assert.deepEqual(local.models?.map((model) => model.id).sort(), ["one", "two"]);
  });
});

test("models.json schema and compose failures roll back without touching disk", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "models.json");
    const original = '{ // keep me\n  "providers": {}\n}\n';
    await writeFile(file, original);
    await assert.rejects(
      mutateModelsJson(file, (draft) => {
        draft.providers.local = { baseUrl: 42 } as never;
      }),
      /expected a string/,
    );
    assert.equal(await readFile(file, "utf8"), original);
    await assert.rejects(stat(`${file}.bak`));

    await assert.rejects(
      mutateModelsJson(file, (draft) => {
        draft.providers.broken = { models: [{ id: "x" }] };
      }),
      /custom providers need a baseUrl/,
    );
    assert.equal(await readFile(file, "utf8"), original);
  });
});

test("models.json CRUD helpers merge, prune, and delete configuration", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "models.json");
    await upsertProviderConfig(file, "local", {
      baseUrl: "http://localhost:1/v1",
      api: "openai-completions",
      apiKey: "one",
    });
    await upsertProviderConfig(file, "local", { apiKey: null, name: "Local" });
    await upsertCustomModel(file, "local", { id: "model", name: "First" });
    await upsertCustomModel(file, "local", { id: "model", name: "Second", reasoning: true });
    await upsertModelOverride(file, "local", "model", { contextWindow: 4000 });
    await upsertModelOverride(file, "local", "model", { maxTokens: 100 });

    let config = (await readModelsJsonDocument(file)).config;
    assert.equal(config.providers.local?.apiKey, undefined);
    assert.equal(config.providers.local?.models?.[0]?.name, "Second");
    assert.equal(config.providers.local?.modelOverrides?.model?.contextWindow, 4000);
    assert.equal(config.providers.local?.modelOverrides?.model?.maxTokens, 100);

    await deleteModelOverride(file, "local", "model");
    await deleteCustomModel(file, "local", "model");
    config = (await readModelsJsonDocument(file)).config;
    assert.equal(config.providers.local?.modelOverrides, undefined);
    assert.equal(config.providers.local?.models, undefined);
    assert.equal(config.providers.local?.name, "Local");

    await deleteProviderConfig(file, "local");
    assert.deepEqual((await readModelsJsonDocument(file)).config, { providers: {} });
  });
});

test("readModelsJsonDocument reports a missing file without creating it", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "missing.json");
    assert.deepEqual(await readModelsJsonDocument(file), {
      exists: false,
      config: { providers: {} },
      rawText: "",
    });
    await assert.rejects(stat(file));
  });
});

test("models.json and .bak enforce 0o600 permissions on POSIX and writeModelsJsonFile locks and backs up", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "models.json");
    await upsertProviderConfig(file, "local", {
      baseUrl: "http://localhost:1/v1",
      api: "openai-completions",
      apiKey: "secret-1",
      models: [{ id: "m1" }],
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }

    await upsertProviderConfig(file, "local", { name: "Updated" });
    if (process.platform !== "win32") {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(`${file}.bak`)).mode & 0o777, 0o600);
    }

    const file2 = join(dir, "imported-models.json");
    await writeFile(file2, '{"providers":{}}', { mode: 0o644 });
    await writeModelsJsonFile(file2, {
      providers: {
        imported: {
          baseUrl: "http://localhost:2/v1",
          api: "openai-completions",
          apiKey: "imported-secret",
          models: [{ id: "m2" }],
        },
      },
    });
    assert.equal(await readFile(`${file2}.bak`, "utf8"), '{"providers":{}}');
    const doc2 = await readModelsJsonDocument(file2);
    assert.equal(doc2.config.providers.imported?.apiKey, "imported-secret");
    if (process.platform !== "win32") {
      assert.equal((await stat(file2)).mode & 0o777, 0o600);
      assert.equal((await stat(`${file2}.bak`)).mode & 0o777, 0o600);
    }
  });
});
