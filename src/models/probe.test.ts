import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatalog, probeModels } from "./probe.ts";

type Seen = { url: string; headers: Headers };

/** A fetch that answers from a table by URL and records what was asked. */
function fakeFetch(answers: Record<string, { status: number; body: unknown }>) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: new Headers(init?.headers) });
    const answer = answers[url] ?? { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

test("目录按常见字段名带回元数据，字段冲突时取较小的上限", () => {
  const models = parseCatalog({
    data: [
      {
        id: "big",
        name: "Big Model",
        context_length: 200_000,
        max_model_len: 131_072,
        max_output_tokens: 8192,
        architecture: { input_modalities: ["text", "image"] },
        supported_parameters: ["reasoning", "tools"],
      },
      { id: "small", context_window: 0 },
      { slug: "by-slug", display_name: "by-slug" },
      { name: "no id" },
    ],
  });
  assert.deepEqual(models, [
    {
      id: "big",
      name: "Big Model",
      contextWindow: 131_072,
      maxTokens: 8192,
      input: ["text", "image"],
      reasoning: true,
    },
    { id: "small" },
    { id: "by-slug" },
  ]);
  assert.deepEqual(parseCatalog([{ id: "a" }]), [{ id: "a" }]);
  assert.equal(parseCatalog({ object: "list" }), undefined);
  assert.equal(parseCatalog({ data: [{ name: "x" }] }), undefined);
});

test("OpenAI 风格的端点用 Bearer 取 {baseUrl}/models，结果去重排序", async () => {
  const { fetch, seen } = fakeFetch({
    "https://gw.example/v1/models": {
      status: 200,
      body: { data: [{ id: "b" }, { id: "a" }, { id: "b" }] },
    },
  });
  const result = await probeModels({
    baseUrl: "https://gw.example/v1/",
    api: "openai-completions",
    auth: { apiKey: "sk-test" },
    fetch,
  });
  assert.deepEqual(result, { models: [{ id: "a" }, { id: "b" }], truncated: false });
  assert.equal(seen[0]?.headers.get("authorization"), "Bearer sk-test");
});

test("Anthropic 端点先用 x-api-key 取 /v1/models，被拒后去掉 /anthropic 用 Bearer 重试一次", async () => {
  const { fetch, seen } = fakeFetch({
    "https://gw.example/anthropic/v1/models": { status: 401, body: { error: "use bearer" } },
    "https://gw.example/v1/models": { status: 200, body: { data: [{ id: "claude-x" }] } },
  });
  const result = await probeModels({
    baseUrl: "https://gw.example/anthropic",
    api: "anthropic-messages",
    auth: { apiKey: "sk-ant" },
    fetch,
  });
  assert.deepEqual(result.models, [{ id: "claude-x" }]);
  assert.equal(seen[0]?.headers.get("x-api-key"), "sk-ant");
  assert.equal(seen[0]?.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(seen[1]?.headers.get("authorization"), "Bearer sk-ant");
});

test("Anthropic 目录顺着 has_more 翻页", async () => {
  const { fetch } = fakeFetch({
    "https://api.example/v1/models": {
      status: 200,
      body: { data: [{ id: "m1" }], has_more: true, last_id: "m1" },
    },
    "https://api.example/v1/models?after_id=m1&limit=1000": {
      status: 200,
      body: { data: [{ id: "m2" }], has_more: false },
    },
  });
  const result = await probeModels({
    baseUrl: "https://api.example",
    api: "anthropic-messages",
    fetch,
  });
  assert.deepEqual(result, { models: [{ id: "m1" }, { id: "m2" }], truncated: false });
});

test("失败时说明原因，并且不复述凭据", async () => {
  const { fetch } = fakeFetch({
    "https://gw.example/v1/models": { status: 403, body: { error: "bad key sk-secret" } },
  });
  await assert.rejects(
    probeModels({
      baseUrl: "https://gw.example/v1",
      api: "openai-responses",
      auth: { apiKey: "sk-secret" },
      fetch,
    }),
    (error: { problem: { code: string; detail: string } }) => {
      assert.equal(error.problem.code, "probe_failed");
      assert.match(error.problem.detail, /HTTP 403/);
      assert.doesNotMatch(error.problem.detail, /sk-secret/);
      return true;
    },
  );
  await assert.rejects(probeModels({ baseUrl: "not a url", fetch }), {
    problem: { code: "invalid", field: "baseUrl" },
  });
});

test("端点不响应时按时限放弃", async () => {
  const fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof globalThis.fetch;
  await assert.rejects(probeModels({ baseUrl: "http://127.0.0.1:9/v1", fetch, timeoutMs: 20 }), {
    problem: { code: "probe_failed", detail: "0.02 秒内没有响应" },
  });
});

test("连不上时带出底层原因，而不只是 fetch failed", async () => {
  const fetch = (async () => {
    throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });
  }) as typeof globalThis.fetch;
  await assert.rejects(probeModels({ baseUrl: "http://127.0.0.1:1/v1", fetch }), {
    problem: { code: "probe_failed", detail: "fetch failed（connect ECONNREFUSED 127.0.0.1:1）" },
  });
});
