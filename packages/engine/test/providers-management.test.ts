import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider, type Models, type Provider } from "@earendil-works/pi-ai";
import {
  getBuiltinProviderIds,
  getBuiltinProviderInfo,
  type ModelRuntime,
} from "@eevee/agent/models";
import { EeveeApiError, EeveeClient, type ThinkingLevelConfig } from "@eevee/protocol";
import { Engine } from "../src/engine.ts";
import type { ProviderDeps } from "../src/engine-providers.ts";
import { getProviderDetail } from "../src/engine-providers-manage.ts";
import { startEngineHttpServer } from "../src/http.ts";

function thinkingLevels(overrides: Partial<ThinkingLevelConfig> = {}): ThinkingLevelConfig {
  return {
    off: { enabled: false },
    minimal: { enabled: false },
    low: { enabled: false },
    medium: { enabled: false },
    high: { enabled: false },
    xhigh: { enabled: false },
    max: { enabled: false },
    ...overrides,
  };
}

async function withEngine(
  modelsJson: string | undefined,
  run: (context: { client: EeveeClient; engine: Engine; dir: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-providers-3b-"));
  if (modelsJson !== undefined) await writeFile(join(dir, "models.json"), modelsJson);
  const engine = await Engine.open({ dataDir: dir, env: {} });
  const server = await startEngineHttpServer(engine, {
    port: 0,
    token: "providers-test",
    webDistDir: false,
  });
  try {
    await run({
      client: new EeveeClient({ baseUrl: server.url, token: "providers-test" }),
      engine,
      dir,
    });
  } finally {
    await server.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("custom provider HTTP CRUD redacts secrets, round-trips thinking levels, and decodes slash model ids", async () => {
  await withEngine(undefined, async ({ client, dir }) => {
    const catalog = await client.getProviderCatalog();
    assert.ok(catalog.providers.length > 0);
    assert.ok(catalog.supportedApis.includes("openai-responses"));

    const created = await client.createProvider({
      id: "custom",
      name: "Custom Provider",
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-responses",
      apiKey: "literal-secret",
    });
    assert.equal(created.provider.kind, "custom");
    assert.equal(created.provider.config?.hasApiKey, true);
    assert.equal(created.provider.config?.apiKeyRef, undefined);
    assert.equal(JSON.stringify(created).includes("literal-secret"), false);

    const levels = thinkingLevels({
      off: { enabled: true, mappedTo: "off" },
      high: { enabled: true },
      xhigh: { enabled: true },
      max: { enabled: true },
    });
    const withModel = await client.createProviderModel("custom", {
      id: "vendor/model",
      name: "Vendor Model",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 64_000,
      maxTokens: 4096,
      thinkingLevels: levels,
    });
    const model = withModel.provider.models[0];
    assert.equal(model?.id, "vendor/model");
    assert.equal(model?.thinkingLevels.xhigh.enabled, true);
    assert.equal(model?.thinkingLevels.max.enabled, true);
    assert.equal(model?.thinkingLevels.off.mappedTo, "none");
    assert.ok(model?.supportedThinkingLevels.includes("xhigh"));
    assert.ok(model?.supportedThinkingLevels.includes("max"));

    const rawAfterCreate = JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as {
      providers: Record<string, { apiKey?: string; models?: { thinkingLevelMap?: unknown }[] }>;
    };
    assert.equal(rawAfterCreate.providers.custom?.apiKey, "literal-secret");
    assert.deepEqual(
      (
        rawAfterCreate.providers.custom?.models?.[0]?.thinkingLevelMap as
          | Record<string, unknown>
          | undefined
      )?.off,
      "none",
    );

    const renamed = await client.updateProviderModel("custom", "vendor/model", {
      name: "Renamed Model",
    });
    assert.equal(renamed.provider.models[0]?.name, "Renamed Model");
    assert.equal(renamed.provider.models[0]?.thinkingLevels.xhigh.enabled, true);

    const referenced = await client.updateProvider("custom", { apiKey: "$CUSTOM_KEY" });
    assert.equal(referenced.provider.config?.hasApiKey, true);
    assert.equal(referenced.provider.config?.apiKeyRef, "$CUSTOM_KEY");
    assert.equal(JSON.stringify(referenced).includes("literal-secret"), false);

    const listed = await client.listModels({ provider: "custom" });
    assert.equal(listed.models[0]?.input?.includes("image"), true);
    assert.equal(listed.models[0]?.isCustom, true);

    await assert.rejects(client.updateProvider("custom", { api: "unsupported-api" }), (error) => {
      return error instanceof EeveeApiError && error.status === 400;
    });

    const afterDeleteModel = await client.deleteProviderModel("custom", "vendor/model");
    assert.equal(afterDeleteModel.provider.models.length, 0);
    assert.deepEqual(await client.deleteProvider("custom"), { ok: true });
    await assert.rejects(client.getProviderDetail("custom"), (error) => {
      return error instanceof EeveeApiError && error.status === 404;
    });
  });
});

test("builtin model overrides and builtin matching are manageable without replacing the catalog", async () => {
  const providerId = getBuiltinProviderIds().find(
    (id) => (getBuiltinProviderInfo(id)?.models.length ?? 0) > 0,
  );
  assert.ok(providerId);
  const modelId = getBuiltinProviderInfo(providerId)?.models[0]?.id;
  assert.ok(modelId);

  await withEngine(undefined, async ({ client }) => {
    const before = await client.getProviderDetail(providerId);
    const baseline = before.provider.models.find((model) => model.id === modelId);
    assert.ok(baseline);
    assert.equal(baseline.isBuiltin, true);
    assert.equal(baseline.hasOverride, false);

    const updated = await client.updateProviderModel(providerId, modelId, {
      name: "Temporary Override",
    });
    const overridden = updated.provider.models.find((model) => model.id === modelId);
    assert.equal(overridden?.name, "Temporary Override");
    assert.equal(overridden?.hasOverride, true);
    assert.equal(overridden?.isBuiltin, true);

    const matches = await client.matchBuiltinModel(providerId, modelId, {
      query: modelId,
      limit: 3,
    });
    assert.ok(matches.candidates.length > 0);
    assert.ok(matches.candidates[0]?.diffs.every((diff) => "value" in diff));

    const restored = await client.deleteProviderModel(providerId, modelId);
    assert.equal(
      restored.provider.models.find((model) => model.id === modelId)?.name,
      baseline.name,
    );
    await client.updateProvider(providerId, { name: "Builtin Override" });
    const afterDelete = await client.deleteProvider(providerId);
    assert.deepEqual(afterDelete, { ok: true });
    assert.equal((await client.getProviderDetail(providerId)).provider.config, undefined);
  });
});

test("saved-provider probe, atomic model import, and smoke test work against an OpenAI-compatible stub", async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const stub = createServer((req, res) => {
    requests.push({
      url: req.url ?? "",
      authorization: req.headers.authorization ?? null,
    });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "existing", name: "Existing" },
            {
              id: "vendor/model",
              name: "Vendor Model",
              context_length: 32_000,
              max_output_tokens: 2048,
              reasoning: true,
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "vendor/model",
          choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "vendor/model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404).end();
  });
  const baseUrl = await listen(stub);
  const initial = JSON.stringify({
    providers: {
      stub: {
        name: "Stub",
        baseUrl: `${baseUrl}/v1`,
        api: "openai-completions",
        apiKey: "sk-stub",
        models: [{ id: "existing" }],
      },
    },
  });

  try {
    await withEngine(initial, async ({ client, dir }) => {
      const probed = await client.probeProvider("stub");
      assert.equal(probed.ok, true, probed.error ?? "probe failed");
      assert.equal(probed.catalogUrl, `${baseUrl}/v1/models`);
      assert.equal(probed.models.find((model) => model.id === "existing")?.exists, true);
      assert.equal(probed.models.find((model) => model.id === "vendor/model")?.exists, false);

      const imported = await client.importProviderModels("stub", {
        models: [
          {
            id: "vendor/model",
            name: "Vendor Model",
            contextWindow: 32_000,
            maxTokens: 2048,
            reasoning: true,
          },
        ],
      });
      assert.equal(imported.imported, 1);
      assert.equal(imported.provider.models.length, 2);
      const raw = JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as {
        providers: Record<string, { models: unknown[] }>;
      };
      assert.equal(raw.providers.stub?.models.length, 2);

      const smoke = await client.testProviderModel("stub", "vendor/model", {
        timeoutMs: 5000,
      });
      assert.equal(smoke.ok, true, smoke.error ?? "smoke test failed");
      assert.equal(smoke.replyPreview, "OK");
      assert.equal(smoke.usage?.totalTokens, 5);
      assert.ok(requests.some((request) => request.url === "/v1/chat/completions"));
      assert.ok(requests.every((request) => request.authorization === "Bearer sk-stub"));
    });
  } finally {
    await closeServer(stub);
  }
});

test("models reload reports malformed models.json diagnostics and recovers on the next reload", async () => {
  await withEngine(undefined, async ({ client, dir }) => {
    await writeFile(join(dir, "models.json"), '{\n  "providers": { broken');
    const malformed = await client.reloadModels();
    assert.equal(malformed.reloaded, true);
    assert.ok(malformed.diagnostics.length > 0);
    assert.match(malformed.diagnostics[0]?.message ?? "", /invalid JSON/i);
    const listed = await client.listProviders();
    assert.ok((listed.diagnostics?.length ?? 0) > 0);

    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            models: [{ id: "one" }],
          },
        },
      }),
    );
    const recovered = await client.reloadModels();
    assert.deepEqual(recovered.diagnostics, []);
    assert.ok(recovered.providerCount > 0);
    assert.ok(recovered.modelCount > 0);
    assert.equal((await client.getProviderDetail("local")).provider.models[0]?.id, "one");
  });
});

test("getProviderDetail only inspects the requested provider without scanning unrelated providers", async () => {
  const targetFaux = fauxProvider({ provider: "target-p", models: [{ id: "m1" }] });
  const otherFaux = fauxProvider({ provider: "other-p", models: [{ id: "m2" }] });
  let otherModelsCalls = 0;
  const wrappedOther: Provider = {
    ...otherFaux.provider,
    getModels: () => {
      otherModelsCalls += 1;
      return otherFaux.provider.getModels();
    },
  };

  const baseModels = createModels();
  baseModels.setProvider(targetFaux.provider);
  baseModels.setProvider(wrappedOther);

  let getProvidersCalls = 0;
  const checkAuthCalls: string[] = [];
  const getAvailableCalls: (string | undefined)[] = [];
  const authSummaryCalls: string[] = [];

  const spiedModels: Models = new Proxy(baseModels, {
    get(target, prop, receiver) {
      if (prop === "getProviders") {
        return () => {
          getProvidersCalls += 1;
          return target.getProviders();
        };
      }
      if (prop === "checkAuth") {
        return (providerId: string) => {
          checkAuthCalls.push(providerId);
          return target.checkAuth(providerId);
        };
      }
      if (prop === "getAvailable") {
        return (providerId?: string) => {
          getAvailableCalls.push(providerId);
          return target.getAvailable(providerId);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const spiedRuntime = {
    config: () => ({ providers: {} }),
    getAuthSummary: async (providerId: string) => {
      authSummaryCalls.push(providerId);
      return { configured: false };
    },
  } as unknown as ModelRuntime;

  const deps: ProviderDeps = {
    models: () => spiedModels,
    credentials: () => undefined,
    runtime: () => spiedRuntime,
  };

  const detail = await getProviderDetail(deps, "target-p");
  assert.equal(detail.provider.id, "target-p");
  assert.equal(detail.provider.models.length, 1);
  assert.equal(getProvidersCalls, 0);
  assert.equal(otherModelsCalls, 0);
  assert.deepEqual(checkAuthCalls, ["target-p"]);
  assert.deepEqual(authSummaryCalls, ["target-p"]);
  assert.deepEqual(getAvailableCalls, ["target-p"]);
});
