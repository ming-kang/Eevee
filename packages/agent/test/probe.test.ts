import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Models,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  baseUrlPlaceholder,
  compatFieldsForApi,
  computeBuiltinFieldDiffs,
  describeConnectionUrl,
  matchBuiltinModels,
  modelCatalogUrl,
  probeProviderModels,
  resolveModelSpec,
  runModelSmokeTest,
  validateBaseUrl,
} from "../src/models/index.ts";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function model(id: string, provider = "local", api = "openai-completions"): Model<Api> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: "http://localhost:1/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

test("modelCatalogUrl and connection previews handle Anthropic and doubled /v1", () => {
  assert.equal(
    modelCatalogUrl(new URL("https://api.anthropic.com"), "anthropic-messages").toString(),
    "https://api.anthropic.com/v1/models",
  );
  assert.equal(
    modelCatalogUrl(new URL("https://gateway.test/v1/"), "openai-completions").toString(),
    "https://gateway.test/v1/models",
  );
  assert.deepEqual(describeConnectionUrl("openai-completions", "https://x.test/v1/v1"), {
    text: "https://x.test/v1/v1/models",
    warning: true,
  });
  assert.equal(validateBaseUrl("file:///tmp/models"), "Base URL must use http or https");
  assert.equal(baseUrlPlaceholder("anthropic-messages"), "https://api.anthropic.com");
});

test("probeProviderModels parses OpenAI models and applies bearer auth", async () => {
  let authorization: string | null = null;
  const result = await probeProviderModels({
    baseUrl: "https://gateway.test/v1",
    api: "openai-completions",
    auth: { apiKey: "secret" },
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return response({
        data: [
          {
            id: "model-a",
            display_name: "Model A",
            context_length: 12345,
            max_output_tokens: 678,
            input_modalities: ["text", "image"],
            supported_features: ["reasoning"],
          },
        ],
      });
    },
  });
  assert.equal(authorization, "Bearer secret");
  assert.deepEqual(result.models, [
    {
      id: "model-a",
      name: "Model A",
      contextWindow: 12345,
      maxTokens: 678,
      input: ["text", "image"],
      reasoning: true,
    },
  ]);
});

test("probeProviderModels follows bounded Anthropic pagination", async () => {
  const urls: string[] = [];
  const result = await probeProviderModels({
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    auth: { apiKey: "anthropic-secret" },
    fetch: async (input) => {
      urls.push(String(input));
      return urls.length === 1
        ? response({ data: [{ id: "one" }], has_more: true, last_id: "one" })
        : response({ data: [{ id: "two" }], has_more: false, last_id: "two" });
    },
  });
  assert.equal(result.pageCount, 2);
  assert.deepEqual(
    result.models.map((entry) => entry.id),
    ["one", "two"],
  );
  assert.equal(new URL(urls[1] ?? "").searchParams.get("after_id"), "one");
});

test("probeProviderModels retries an Anthropic gateway once as OpenAI", async () => {
  const requests: { url: string; headers: Headers }[] = [];
  const result = await probeProviderModels({
    baseUrl: "https://gateway.test/v1/anthropic",
    api: "anthropic-messages",
    auth: { apiKey: "retry-secret" },
    fetch: async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return requests.length === 1
        ? response({ error: "missing" }, 404)
        : response({ models: [{ id: "ok" }] });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://gateway.test/v1/anthropic/models");
  assert.equal(requests[1]?.url, "https://gateway.test/v1/models");
  assert.equal(requests[1]?.headers.get("authorization"), "Bearer retry-secret");
  assert.equal(requests[1]?.headers.get("x-api-key"), null);
  assert.deepEqual(
    result.models.map((entry) => entry.id),
    ["ok"],
  );
});

test("probeProviderModels caps catalogs at 2000 models", async () => {
  const result = await probeProviderModels({
    baseUrl: "https://gateway.test/v1",
    fetch: async () =>
      response({ data: Array.from({ length: 2005 }, (_, index) => ({ id: `m-${index}` })) }),
  });
  assert.equal(result.models.length, 2000);
  assert.equal(result.truncated, true);
  assert.equal(result.models.at(-1)?.id, "m-1999");
});

test("probeProviderModels honors timeout and external cancellation", async () => {
  const pendingFetch: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  await assert.rejects(
    probeProviderModels({ baseUrl: "https://x.test/v1", fetch: pendingFetch, timeoutMs: 10 }),
    /timed out/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    probeProviderModels({
      baseUrl: "https://x.test/v1",
      fetch: pendingFetch,
      signal: controller.signal,
    }),
    /aborted/,
  );
});

test("probeProviderModels redacts keys, headers, and ANSI from errors", async () => {
  await assert.rejects(
    probeProviderModels({
      baseUrl: "https://x.test/v1",
      auth: { apiKey: "sk-super-secret", headers: { "X-Token": "header-secret" } },
      fetch: async () =>
        new Response("\u001b[31msk-super-secret header-secret\u001b[0m", { status: 400 }),
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!message.includes("sk-super-secret"));
      assert.ok(!message.includes("header-secret"));
      assert.ok(!message.includes("\u001b"));
      assert.ok(message.includes("[redacted]"));
      return true;
    },
  );
});

test("builtin matcher and compat metadata provide completion data", () => {
  const exact = matchBuiltinModels("claude-opus-4-6", "anthropic-messages", 3);
  assert.ok(exact.length > 0);
  assert.equal(exact[0]?.tier, "exact");
  assert.equal(exact[0]?.model.id, "claude-opus-4-6");
  assert.ok(
    matchBuiltinModels("claudeopus46", undefined, 3).some((entry) => entry.tier !== "fuzzy"),
  );
  const fields = compatFieldsForApi("openai-completions");
  assert.equal(fields.find((field) => field.key === "supportsStore")?.kind, "boolean");
  assert.deepEqual(fields.find((field) => field.key === "maxTokensField")?.options, [
    "max_completion_tokens",
    "max_tokens",
  ]);
  assert.equal(fields.find((field) => field.key === "chatTemplateKwargs")?.kind, "stringMap");
});

test("builtin diffs omit cost tiers and block cross-API protocol fields", () => {
  const reference = {
    ...model("reference", "anthropic", "anthropic-messages"),
    thinkingLevelMap: { high: "high" },
    compat: { supportsTemperature: false },
    cost: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 100, input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }],
    },
  } as Model<Api>;
  const diffs = computeBuiltinFieldDiffs({}, reference, "openai-completions");
  const compat = diffs.find((diff) => diff.field === "compat");
  const thinking = diffs.find((diff) => diff.field === "thinkingLevelMap");
  const cost = diffs.find((diff) => diff.field === "cost");
  assert.equal(compat?.applicable, false);
  assert.equal(compat?.checked, false);
  assert.equal(thinking?.applicable, false);
  assert.ok(cost && !cost.referenceText.includes("tiers"));
  assert.ok(cost && !Object.hasOwn(cost.value as object, "tiers"));
  const sameApi = computeBuiltinFieldDiffs({}, reference, "anthropic-messages");
  assert.equal(sameApi.find((diff) => diff.field === "thinkingLevelMap")?.applicable, true);
});

function smokeModels(secret = "smoke-secret"): {
  readonly models: Models;
  readonly options: { current?: ModelsSimpleStreamOptions };
} {
  const current: { current?: ModelsSimpleStreamOptions } = {};
  const selected = model("smoke");
  const usage = {
    input: 3,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "OK" },
      { type: "toolCall", id: "call", name: "eevee_smoke_test", arguments: {} },
    ],
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  const models = {
    getModel: () => selected,
    getAuth: () => ({ auth: { apiKey: secret }, source: "test" }),
    streamSimple: (_model: Model<Api>, _context: unknown, options?: ModelsSimpleStreamOptions) => {
      current.current = options;
      const stream = createAssistantMessageEventStream();
      const partial = { ...message, content: [] };
      stream.push({ type: "start", partial });
      stream.push({ type: "thinking_delta", contentIndex: 0, delta: "think", partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "OK", partial });
      stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial });
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    },
  } as unknown as Models;
  return { models, options: current };
}

test("runModelSmokeTest measures streamed output, reasoning, tools, and usage", async () => {
  const fake = smokeModels();
  const result = await runModelSmokeTest({
    models: fake.models,
    providerId: "local",
    modelId: "smoke",
    thinkingLevel: "high",
    testTools: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.replyPreview, "OK");
  assert.equal(result.sawReasoning, true);
  assert.equal(result.sawToolCall, true);
  assert.equal(result.usage?.totalTokens, 5);
  assert.ok(result.ttftMs !== undefined);
  assert.equal(fake.options.current?.reasoning, "high");
  assert.equal(fake.options.current?.maxTokens, 32);
});

test("runModelSmokeTest sanitizes resolved credentials in errors", async () => {
  const selected = model("smoke");
  const models = {
    getModel: () => selected,
    getAuth: () => ({ auth: { apiKey: "never-print-this" } }),
    streamSimple: () => {
      throw new Error("request failed with never-print-this");
    },
  } as unknown as Models;
  const result = await runModelSmokeTest({ models, providerId: "local", modelId: "smoke" });
  assert.equal(result.ok, false);
  assert.ok(!result.error?.includes("never-print-this"));
  assert.ok(result.error?.includes("[redacted]"));
});

test("resolveModelSpec handles slash providers, thinking suffixes, and fuzzy matches", () => {
  const slashProvider = { id: "team/gateway" };
  const otherProvider = { id: "other" };
  const slashModel = model("vendor/reasoner", slashProvider.id);
  const colonModel = model("plain:high", slashProvider.id);
  const otherModel = model("vendor/reasoner-two", otherProvider.id);
  const all = [slashModel, colonModel, otherModel];
  const models = {
    getProviders: () => [slashProvider, otherProvider],
    getModels: (provider?: string) =>
      provider ? all.filter((entry) => entry.provider === provider) : all,
  } as unknown as Models;

  const resolved = resolveModelSpec(models, "team/gateway/vendor/reasoner:high");
  assert.equal(resolved.kind, "resolved");
  assert.equal(resolved.kind === "resolved" ? resolved.thinkingLevel : undefined, "high");
  const literal = resolveModelSpec(models, "team/gateway/plain:high");
  assert.equal(literal.kind, "resolved");
  assert.equal(literal.kind === "resolved" ? literal.thinkingLevel : undefined, undefined);
  assert.equal(resolveModelSpec(models, "VENDOR/REASONER-TWO").kind, "resolved");
  assert.equal(resolveModelSpec(models, "vendor/reason").kind, "ambiguous");
});

test("resolveModelSpec reports exact-ID ambiguity across providers", () => {
  const providers = [{ id: "one" }, { id: "two" }];
  const all = [model("shared", "one"), model("shared", "two")];
  const models = {
    getProviders: () => providers,
    getModels: (provider?: string) =>
      provider ? all.filter((entry) => entry.provider === provider) : all,
  } as unknown as Models;
  const result = resolveModelSpec(models, "shared");
  assert.equal(result.kind, "ambiguous");
  assert.equal(result.kind === "ambiguous" ? result.matches.length : 0, 2);
  assert.deepEqual(resolveModelSpec(models, "missing"), { kind: "not_found" });
});

test("probeProviderModels uses x-goog-api-key for Google APIs and redacts it on errors", async () => {
  let seenKey: string | null = null;
  await assert.rejects(
    probeProviderModels({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      api: "google-generative-ai",
      auth: { apiKey: "AIza-secret-token" },
      fetch: async (_input, init) => {
        seenKey = new Headers(init?.headers).get("x-goog-api-key");
        return new Response("bad key AIza-secret-token", { status: 403 });
      },
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!message.includes("AIza-secret-token"));
      assert.ok(message.includes("[redacted]"));
      return true;
    },
  );
  assert.equal(seenKey, "AIza-secret-token");
});

test("runModelSmokeTest reports timeout and abort cleanly while redacting secrets", async () => {
  const selected = model("smoke");
  const models = {
    getModel: () => selected,
    getAuth: () => ({ auth: { apiKey: "smoke-timeout-secret" } }),
    streamSimple: (_model: Model<Api>, _context: unknown, options?: ModelsSimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      const emitAborted = () => {
        stream.push({
          type: "error",
          reason: "aborted",
          error: {
            role: "assistant",
            content: [],
            api: selected.api,
            provider: selected.provider,
            model: selected.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "aborted",
            errorMessage: "aborted with smoke-timeout-secret",
            timestamp: Date.now(),
          },
        });
      };
      if (options?.signal?.aborted) emitAborted();
      else options?.signal?.addEventListener("abort", emitAborted, { once: true });
      return stream;
    },
  } as unknown as Models;

  const timedOut = await runModelSmokeTest({
    models,
    providerId: "local",
    modelId: "smoke",
    timeoutMs: 10,
  });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error ?? "", /timed out/);

  const controller = new AbortController();
  controller.abort();
  const aborted = await runModelSmokeTest({
    models,
    providerId: "local",
    modelId: "smoke",
    signal: controller.signal,
  });
  assert.equal(aborted.ok, false);
  assert.match(aborted.error ?? "", /aborted/);
});
