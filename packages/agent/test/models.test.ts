import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context, ModelsStoreEntry } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  composeProviders,
  FileModelsStore,
  ModelRuntime,
  ModelsConfigError,
  parseModelsConfig,
} from "../src/models/index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "eevee-models-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function userMessage(text: string): Context {
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: text, timestamp: Date.now() }],
  };
}

test("parseModelsConfig parses an empty config and tolerates comments and BOM", () => {
  assert.deepEqual(parseModelsConfig("{}"), { providers: {} });
  assert.deepEqual(parseModelsConfig("﻿{ // comment\n }"), { providers: {} });
  const config = parseModelsConfig('{ "providers": {} }');
  assert.deepEqual(config.providers, {});
});

test("parseModelsConfig parses provider fields and rejects malformed values", () => {
  const config = parseModelsConfig(
    JSON.stringify({
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          apiKey: "$OLLAMA_KEY",
          authHeader: true,
          headers: { "X-Team": `\${TEAM}` },
          models: [
            {
              id: "qwen",
              name: "Qwen",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 32000,
              maxTokens: 4096,
              cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
              thinkingLevelMap: { xhigh: "xhigh", minimal: null },
            },
          ],
          modelOverrides: {
            "some-model": { contextWindow: 64000, cost: { input: 5 } },
          },
        },
      },
    }),
  );
  const provider = config.providers.ollama;
  assert.ok(provider);
  assert.equal(provider.baseUrl, "http://localhost:11434/v1");
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.apiKey, "$OLLAMA_KEY");
  assert.equal(provider.authHeader, true);
  assert.deepEqual(provider.headers, { "X-Team": `\${TEAM}` });
  const model = provider.models?.[0];
  assert.ok(model);
  assert.equal(model.id, "qwen");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.cost?.input, 1);
  assert.equal(model.thinkingLevelMap?.xhigh, "xhigh");
  assert.equal(model.thinkingLevelMap?.minimal, null);
  assert.equal(provider.modelOverrides?.["some-model"]?.contextWindow, 64000);
  assert.equal(provider.modelOverrides?.["some-model"]?.cost?.input, 5);

  assert.throws(
    () => parseModelsConfig('{"providers": {"x": {"baseUrl": 42}}}'),
    ModelsConfigError,
  );
  assert.throws(
    () => parseModelsConfig('{"providers": {"x": {"models": [{"name": "noid"}]}}}'),
    ModelsConfigError,
  );
  assert.throws(
    () => parseModelsConfig('{"providers": {"x": {"models": [{"id": "a", "input": ["video"]}]}}}'),
    ModelsConfigError,
  );
});

test("composeProviders returns built-in providers for an empty config", () => {
  const providers = composeProviders({ providers: {} }, { env: {} });
  const ids = providers.map((provider) => provider.id);
  assert.ok(ids.includes("anthropic"));
  assert.ok(ids.includes("openai"));
});

test("composeProviders adds a custom provider with documented defaults", () => {
  const config = parseModelsConfig(
    JSON.stringify({
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: [{ id: "qwen2.5-coder:7b" }],
        },
      },
    }),
  );
  const providers = composeProviders(config, { env: {} });
  const ollama = providers.find((provider) => provider.id === "ollama");
  assert.ok(ollama);
  const model = ollama.getModels().find((entry) => entry.id === "qwen2.5-coder:7b");
  assert.ok(model);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "http://localhost:11434/v1");
  assert.equal(model.reasoning, false);
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.maxTokens, 16384);
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.cost.input, 0);
  assert.equal(model.provider, "ollama");
});

test("composeProviders rejects custom providers without endpoint or with unknown api", () => {
  const missingEndpoint = parseModelsConfig(
    JSON.stringify({ providers: { broken: { models: [{ id: "x" }] } } }),
  );
  assert.throws(() => composeProviders(missingEndpoint, { env: {} }), ModelsConfigError);

  const unknownApi = parseModelsConfig(
    JSON.stringify({
      providers: { broken: { baseUrl: "http://x", api: "not-a-real-api", models: [{ id: "x" }] } },
    }),
  );
  assert.throws(() => composeProviders(unknownApi, { env: {} }), /unknown api/);
});

test("composeProviders rewrites built-in baseUrl and merges modelOverrides", () => {
  const config = parseModelsConfig(
    JSON.stringify({
      providers: {
        anthropic: {
          baseUrl: "https://proxy.example.com/v1",
          modelOverrides: {
            "claude-opus-4-6": { contextWindow: 555000, cost: { input: 99 } },
            "not-a-real-model": { contextWindow: 1 },
          },
        },
      },
    }),
  );
  const providers = composeProviders(config, { env: {} });
  const anthropic = providers.find((provider) => provider.id === "anthropic");
  assert.ok(anthropic);
  const models = anthropic.getModels();
  assert.ok(models.length > 0);
  for (const model of models) {
    assert.equal(model.baseUrl, "https://proxy.example.com/v1");
  }
  const overridden = models.find((model) => model.id === "claude-opus-4-6");
  assert.ok(overridden);
  assert.equal(overridden.contextWindow, 555000);
  assert.equal(overridden.cost.input, 99);
  assert.ok(overridden.cost.output > 0);
  assert.equal(
    models.find((model) => model.id === "not-a-real-model"),
    undefined,
  );
});

test("composeProviders replaces a built-in model wholesale through a models entry", () => {
  const builtin = composeProviders({ providers: {} }, { env: {} })
    .find((provider) => provider.id === "anthropic")
    ?.getModels()[0];
  assert.ok(builtin);
  const config = parseModelsConfig(
    JSON.stringify({
      providers: {
        anthropic: {
          models: [{ id: builtin.id, api: "anthropic-messages" }],
        },
      },
    }),
  );
  const providers = composeProviders(config, { env: {} });
  const replaced = providers
    .find((provider) => provider.id === "anthropic")
    ?.getModels()
    .find((model) => model.id === builtin.id);
  assert.ok(replaced);
  assert.equal(replaced.contextWindow, 128000);
  assert.equal(replaced.cost.input, 0);
  const untouched = providers
    .find((provider) => provider.id === "anthropic")
    ?.getModels()
    .find((model) => model.id !== builtin.id);
  assert.ok(untouched);
  assert.ok(untouched.contextWindow !== 128000 || untouched.cost.input !== 0);
});

test("ModelRuntime resolves custom provider auth from models.json apiKey", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "test-key",
            models: [{ id: "qwen" }],
          },
        },
      }),
    );
    const runtime = await ModelRuntime.open({ dir, env: {} });
    const model = runtime.resolveModel({ provider: "ollama", modelId: "qwen" });
    assert.ok(model);
    const auth = await runtime.models().getAuth(model);
    assert.ok(auth);
    assert.equal(auth.auth.apiKey, "test-key");
    assert.equal(auth.source, "models.json");
  });
});

test("ModelRuntime resolves $ENV apiKey interpolation hermetically", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          proxy: {
            baseUrl: "http://localhost:9999/v1",
            api: "openai-completions",
            apiKey: `Bearer-\${PROXY_KEY}`,
            models: [{ id: "m" }],
          },
        },
      }),
    );
    const runtime = await ModelRuntime.open({ dir, env: { PROXY_KEY: "secret" } });
    const model = runtime.resolveModel({ provider: "proxy", modelId: "m" });
    assert.ok(model);
    const auth = await runtime.models().getAuth(model);
    assert.equal(auth?.auth.apiKey, "Bearer-secret");

    const missing = await ModelRuntime.open({ dir, env: {} });
    const missingModel = missing.resolveModel({ provider: "proxy", modelId: "m" });
    assert.ok(missingModel);
    assert.equal(await missing.models().getAuth(missingModel), undefined);
  });
});

test("ModelRuntime auth precedence: stored credential beats models.json, models.json beats env vars", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: { apiKey: "sk-config" },
        },
      }),
    );
    const env = { ANTHROPIC_API_KEY: "sk-env" };
    const runtime = await ModelRuntime.open({ dir, env });
    const model = runtime.models().getModels("anthropic")[0];
    assert.ok(model);

    assert.equal((await runtime.models().getAuth(model))?.auth.apiKey, "sk-config");

    await runtime.credentials.modify("anthropic", async () => ({
      type: "api_key",
      key: "sk-stored",
    }));
    assert.equal((await runtime.models().getAuth(model))?.auth.apiKey, "sk-stored");

    await runtime.credentials.delete("anthropic");
    assert.equal((await runtime.models().getAuth(model))?.auth.apiKey, "sk-config");
  });
});

test("ModelRuntime falls back to provider env vars without config apiKey", async () => {
  await withTempDir(async (dir) => {
    const runtime = await ModelRuntime.open({ dir, env: { ANTHROPIC_API_KEY: "sk-env-only" } });
    const model = runtime.models().getModels("anthropic")[0];
    assert.ok(model);
    const auth = await runtime.models().getAuth(model);
    assert.equal(auth?.auth.apiKey, "sk-env-only");
    assert.equal(auth?.source, "ANTHROPIC_API_KEY");

    const bare = await ModelRuntime.open({ dir, env: {} });
    const bareModel = bare.models().getModels("anthropic")[0];
    assert.ok(bareModel);
    assert.equal(await bare.models().getAuth(bareModel), undefined);
  });
});

test("ModelRuntime authHeader sends the key as a bearer header instead of apiKey", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          proxy: {
            baseUrl: "http://localhost:9999/v1",
            api: "openai-completions",
            apiKey: "key123",
            authHeader: true,
            models: [{ id: "m" }],
          },
        },
      }),
    );
    const runtime = await ModelRuntime.open({ dir, env: {} });
    const model = runtime.resolveModel({ provider: "proxy", modelId: "m" });
    assert.ok(model);
    const auth = await runtime.models().getAuth(model);
    assert.equal(auth?.auth.apiKey, undefined);
    assert.equal(auth?.auth.headers?.Authorization, "Bearer key123");
  });
});

test("ModelRuntime streams through a custom provider offline with injected headers", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "stream-key",
            headers: { "X-Provider-Header": "provider-value" },
            models: [
              {
                id: "offline-model",
                headers: { "X-Model-Header": "model-$SUFFIX" },
              },
            ],
          },
        },
      }),
    );
    const runtime = await ModelRuntime.open({ dir, env: { SUFFIX: "value" } });
    const model = runtime.resolveModel({ provider: "local", modelId: "offline-model" });
    assert.ok(model);

    const captured: { url?: string; headers?: Record<string, string> } = {};
    const flattenHeaders = (headers: unknown): Record<string, string> => {
      if (headers instanceof Headers) return Object.fromEntries(headers.entries());
      if (Array.isArray(headers)) return Object.fromEntries(headers);
      if (typeof headers === "object" && headers !== null)
        return { ...(headers as Record<string, string>) };
      return {};
    };
    const sse = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n");
    const fakeFetch = async (input: unknown, init?: { headers?: unknown }) => {
      captured.url = String(input);
      captured.headers = flattenHeaders(init?.headers);
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const message = await runtime.models().complete(model, userMessage("hi"), {
      fetch: fakeFetch as typeof globalThis.fetch,
    });
    assert.equal(message.stopReason, "stop");
    const text = message.content.find((block) => block.type === "text");
    assert.ok(text && text.type === "text");
    assert.equal(text.text, "hello");
    assert.ok(captured.url?.endsWith("/chat/completions"));

    const flat = Object.entries(captured.headers ?? {}).map(([key, value]): [string, string] => [
      key.toLowerCase(),
      value,
    ]);
    const headerMap = new Map(flat);
    assert.equal(headerMap.get("authorization"), "Bearer stream-key");
    assert.equal(headerMap.get("x-provider-header"), "provider-value");
    assert.equal(headerMap.get("x-model-header"), "model-value");
  });
});

test("ModelRuntime reload picks up models.json changes", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "models.json");
    await writeFile(file, "{}");
    const runtime = await ModelRuntime.open({ dir, env: {} });
    assert.equal(runtime.resolveModel({ provider: "ollama", modelId: "qwen" }), undefined);

    await writeFile(
      file,
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            models: [{ id: "qwen" }],
          },
        },
      }),
    );
    await runtime.reload();
    assert.ok(runtime.resolveModel({ provider: "ollama", modelId: "qwen" }));
  });
});

test("ModelRuntime resolveChoice clamps unsupported thinking levels", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://localhost:1/v1",
            api: "openai-completions",
            models: [
              { id: "plain" },
              { id: "thinker", reasoning: true, thinkingLevelMap: { minimal: null } },
            ],
          },
        },
      }),
    );
    const runtime = await ModelRuntime.open({ dir, env: {} });
    const plain = runtime.resolveChoice({
      provider: "local",
      modelId: "plain",
      thinkingLevel: "high",
    });
    assert.equal(plain?.thinkingLevel, "off");
    const thinker = runtime.resolveChoice({
      provider: "local",
      modelId: "thinker",
      thinkingLevel: "minimal",
    });
    assert.equal(thinker?.thinkingLevel, "low");
    const exact = runtime.resolveChoice({
      provider: "local",
      modelId: "thinker",
      thinkingLevel: "high",
    });
    assert.equal(exact?.thinkingLevel, "high");
    assert.equal(runtime.resolveChoice({ provider: "local", modelId: "missing" }), undefined);
  });
});

test("AuthStorage persists credentials in the Pi auth.json format", async () => {
  await withTempDir(async (dir) => {
    const storage = new AuthStorage(join(dir, "auth.json"));
    assert.equal(await storage.read("anthropic"), undefined);

    const written = await storage.modify("anthropic", async (current) => {
      assert.equal(current, undefined);
      return { type: "api_key", key: "sk-test" };
    });
    assert.deepEqual(written, { type: "api_key", key: "sk-test" });

    const onDisk = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.deepEqual(onDisk, { anthropic: { type: "api_key", key: "sk-test" } });

    assert.deepEqual(await storage.read("anthropic"), { type: "api_key", key: "sk-test" });
    assert.deepEqual(await storage.list(), [{ providerId: "anthropic", type: "api_key" }]);

    const unchanged = await storage.modify("anthropic", async () => undefined);
    assert.deepEqual(unchanged, { type: "api_key", key: "sk-test" });

    await storage.delete("anthropic");
    assert.equal(await storage.read("anthropic"), undefined);
    await storage.delete("anthropic");
  });
});

test("AuthStorage serializes concurrent modifications without losing updates", async () => {
  await withTempDir(async (dir) => {
    const storage = new AuthStorage(join(dir, "auth.json"));
    await storage.modify("counter", async () => ({ type: "api_key", key: "0" }));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        storage.modify("counter", async (current) => {
          assert.equal(current?.type, "api_key");
          return { type: "api_key", key: `${index}` };
        }),
      ),
    );
    const final = await storage.read("counter");
    assert.equal(final?.type, "api_key");
  });
});

test("AuthStorage throws on a corrupt file so writes cannot silently drop other providers", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "auth.json"), "not json {{{");
    const storage = new AuthStorage(join(dir, "auth.json"));
    await assert.rejects(storage.read("x"), /Failed to read auth\.json/);
    await assert.rejects(storage.list(), /Failed to read auth\.json/);
    await assert.rejects(
      storage.modify("x", async () => ({ type: "api_key", key: "k" })),
      /Failed to read auth\.json/,
    );
    assert.equal((await readFile(join(dir, "auth.json"), "utf8")).length > 0, true);
  });
});

test("AuthStorage validates credential shapes strictly", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ bad: { type: "oauth", access: 1 } }));
    const storage = new AuthStorage(join(dir, "auth.json"));
    await assert.rejects(storage.read("bad"), /Invalid auth\.json credential/);
  });
});

test("AuthStorage resolves $ENV references and !commands in api_key credentials", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({
        p: { type: "api_key", key: "$STORED_KEY", env: { STORED_KEY: "resolved-key" } },
        cmd: { type: "api_key", key: "!echo secret" },
      }),
    );
    const storage = new AuthStorage(join(dir, "auth.json"));
    const resolved = await storage.read("p");
    assert.equal(resolved?.type === "api_key" ? resolved.key : undefined, "resolved-key");
    const command = await storage.read("cmd");
    assert.equal(command?.type === "api_key" ? command.key : undefined, "secret");
  });
});

test("AuthStorage merges credential env over the base env", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({
        p: {
          type: "api_key",
          key: "$BASE_KEY-$OVERRIDE_KEY",
          env: { OVERRIDE_KEY: "credential" },
        },
      }),
    );
    const storage = new AuthStorage(join(dir, "auth.json"), {
      BASE_KEY: "base",
      OVERRIDE_KEY: "base",
    });
    const resolved = await storage.read("p");
    assert.equal(resolved?.type === "api_key" ? resolved.key : undefined, "base-credential");
  });
});

test("ModelRuntime passes its base env through AuthStorage credential resolution", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({
        anthropic: {
          type: "api_key",
          key: "$RUNTIME_STORED_KEY",
          env: { CLOUDFLARE_ACCOUNT_ID: "account-id" },
        },
      }),
    );
    const runtime = await ModelRuntime.open({ dir, env: { RUNTIME_STORED_KEY: "sk-runtime" } });
    const model = runtime.models().getModels("anthropic")[0];
    assert.ok(model);
    const auth = await runtime.models().getAuth(model);
    assert.equal(auth?.auth.apiKey, "sk-runtime");
  });
});

test("FileModelsStore throws on a corrupt file instead of dropping catalog data", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "models-store.json"), "{{{ corrupt");
    const store = new FileModelsStore(join(dir, "models-store.json"));
    await assert.rejects(store.read("x"), /Failed to read models-store\.json/);
  });
});

test("FileModelsStore round-trips provider catalog entries", async () => {
  await withTempDir(async (dir) => {
    const store = new FileModelsStore(join(dir, "models-store.json"));
    assert.equal(await store.read("openrouter"), undefined);
    const entry: ModelsStoreEntry = {
      models: [
        {
          id: "m",
          name: "m",
          api: "openai-completions",
          provider: "openrouter",
          baseUrl: "http://x",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: 1,
          maxTokens: 1,
        },
      ],
      checkedAt: 123,
    };
    await store.write("openrouter", entry);
    assert.deepEqual(await store.read("openrouter"), entry);
    await store.delete("openrouter");
    assert.equal(await store.read("openrouter"), undefined);
  });
});

test("ModelRuntime degrades invalid models.json to builtins with diagnostics", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "models.json");
    await writeFile(file, '{\n  "providers": { bad json\n}');
    const runtime = await ModelRuntime.open({ dir, env: {} });
    assert.deepEqual(runtime.config(), { providers: {} });
    assert.ok(runtime.models().getModels("anthropic").length > 0);
    assert.ok(runtime.configDiagnostics().length > 0);
    assert.ok(runtime.configDiagnostics()[0]?.message.includes("invalid JSON"));
    assert.ok(runtime.configDiagnostics()[0]?.line);
    await assert.rejects(ModelRuntime.open({ dir, env: {}, strict: true }), ModelsConfigError);

    await writeFile(file, "{}");
    await runtime.reload();
    assert.deepEqual(runtime.configDiagnostics(), []);
  });
});

test("ModelRuntime reload degrades compose errors without throwing", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "models.json");
    await writeFile(file, "{}");
    const runtime = await ModelRuntime.open({ dir, env: {} });
    await writeFile(
      file,
      JSON.stringify({
        providers: {
          broken: { baseUrl: "http://localhost:1/v1", api: "bad-api", models: [{ id: "x" }] },
        },
      }),
    );
    await runtime.reload();
    assert.deepEqual(runtime.config(), { providers: {} });
    assert.match(runtime.configDiagnostics()[0]?.message ?? "", /unknown api/);
    await assert.rejects(runtime.reload({ strict: true }), /unknown api/);
  });
});

test("ModelRuntime restores cached remote catalogs offline during open", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: { radius: { oauth: "radius", baseUrl: "https://radius.test" } },
      }),
    );
    const store = new FileModelsStore(join(dir, "models-store.json"));
    const cached = modelForStore("radius", "cached-offline-model");
    await store.write("radius", { models: [cached], checkedAt: Date.now() });
    const runtime = await ModelRuntime.open({ dir, env: {} });
    assert.ok(runtime.resolveModel({ provider: "radius", modelId: "cached-offline-model" }));
    const hydrated = await runtime.hydrateStoredCatalogs();
    assert.equal(hydrated.aborted, false);
  });
});

test("ModelRuntime reports masked auth summaries and strict header failures", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: { apiKey: "sk-config-secret" },
          local: {
            baseUrl: "http://localhost:1/v1",
            api: "openai-completions",
            apiKey: "local-key",
            headers: { "X-Required": "$MISSING_HEADER" },
            models: [{ id: "m" }],
          },
        },
      }),
    );
    const runtime = await ModelRuntime.open({ dir, env: {} });
    const summary = await runtime.getAuthSummary("anthropic");
    assert.equal(summary.configured, true);
    assert.equal(summary.source, "models.json");
    assert.equal(summary.type, "api_key");
    assert.equal(summary.preview, "sk-c...cret");
    assert.ok(!summary.preview?.includes("config-secret"));
    const local = runtime.resolveModel({ provider: "local", modelId: "m" });
    assert.ok(local);
    await assert.rejects(runtime.models().getAuth(local), /X-Required.*MISSING_HEADER/);
  });
});

test("AuthStorage credential changes invalidate cached !command values", async () => {
  await withTempDir(async (dir) => {
    const command = 'node -e "console.log(process.hrtime.bigint().toString())"';
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ dynamic: { type: "api_key", key: `!${command}` } }),
    );
    const storage = new AuthStorage(join(dir, "auth.json"));
    const first = await storage.read("dynamic");
    const second = await storage.read("dynamic");
    assert.equal(
      first?.type === "api_key" ? first.key : undefined,
      second?.type === "api_key" ? second.key : undefined,
    );
    await storage.modify("other", async () => ({ type: "api_key", key: "saved" }));
    const third = await storage.read("dynamic");
    assert.notEqual(
      first?.type === "api_key" ? first.key : undefined,
      third?.type === "api_key" ? third.key : undefined,
    );
    await storage.delete("other");
    const fourth = await storage.read("dynamic");
    assert.notEqual(
      third?.type === "api_key" ? third.key : undefined,
      fourth?.type === "api_key" ? fourth.key : undefined,
    );
  });
});

test("models.json !command apiKey bypasses the process cache", async () => {
  await withTempDir(async (dir) => {
    const command = 'node -e "console.log(process.hrtime.bigint().toString())"';
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://localhost:1/v1",
            api: "openai-completions",
            apiKey: `!${command}`,
            models: [{ id: "m" }],
          },
        },
      }),
    );
    const runtime = await ModelRuntime.open({ dir, env: {} });
    const model = runtime.resolveModel({ provider: "local", modelId: "m" });
    assert.ok(model);
    const first = await runtime.models().getAuth(model);
    const second = await runtime.models().getAuth(model);
    assert.ok(first?.auth.apiKey);
    assert.ok(second?.auth.apiKey);
    assert.notEqual(first.auth.apiKey, second.auth.apiKey);
  });
});

function modelForStore(provider: string, id: string): ModelsStoreEntry["models"][number] {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://openrouter.ai/api/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 1000,
    maxTokens: 100,
  };
}

test("!command apiKey executes at resolution time", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://localhost:1/v1",
            api: "openai-completions",
            apiKey: "!echo command-key",
            models: [{ id: "m" }],
          },
        },
      }),
    );
    const runtime = await ModelRuntime.open({ dir, env: {} });
    const model = runtime.resolveModel({ provider: "local", modelId: "m" });
    assert.ok(model);
    const auth = await runtime.models().getAuth(model);
    assert.equal(auth?.auth.apiKey, "command-key");
  });
});
