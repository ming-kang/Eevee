import assert from "node:assert/strict";
import { test } from "node:test";
import type { BuiltinModelView } from "@shared/api/contract.ts";
import { fromRows, isEnvReference, parseTokenCount, toRows } from "./fields.ts";
import {
  addProbed,
  applyReference,
  emptyModelDraft,
  fromDraft,
  isProviderId,
  referenceChanges,
  requestTarget,
  toDraft,
  toModelDraft,
} from "./provider-draft.ts";

test("请求地址按 API 拼出，/v1 重复时标出来；其他 API 不猜", () => {
  assert.deepEqual(requestTarget("openai-completions", "https://gw.example/v1/"), {
    url: "https://gw.example/v1/chat/completions",
    doubled: false,
  });
  assert.deepEqual(requestTarget("anthropic-messages", "https://gw.example/v1"), {
    url: "https://gw.example/v1/v1/messages",
    doubled: true,
  });
  assert.equal(requestTarget("google-vertex", "https://x.example"), undefined);
  assert.equal(requestTarget("openai-responses", "gw.example"), undefined);
  assert.equal(requestTarget("openai-responses", ""), undefined);
});

test("token 数可以写成 128k、1.5m 或带千分位", () => {
  assert.equal(parseTokenCount("128k"), 128_000);
  assert.equal(parseTokenCount("1.5M"), 1_500_000);
  assert.equal(parseTokenCount("200,000"), 200_000);
  assert.equal(parseTokenCount(" "), undefined);
  assert.ok(Number.isNaN(parseTokenCount("0")));
  assert.ok(Number.isNaN(parseTokenCount("lots")));
});

test("键值行：空键丢掉，后写的同名键为准，没有行时为空", () => {
  assert.deepEqual(
    fromRows([
      { key: " X-A ", value: "1" },
      { key: "", value: "ignored" },
      { key: "X-A", value: "2" },
    ]),
    { "X-A": "2" },
  );
  assert.equal(fromRows([]), undefined);
  assert.deepEqual(toRows({ a: "1" }), [{ key: "a", value: "1" }]);
  assert.ok(isEnvReference("$OPENAI_KEY"));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: models.json references variables as ${NAME}
  assert.ok(isEnvReference("${OPENAI_KEY}"));
  assert.ok(!isEnvReference("sk-123"));
});

test("表单改过再写回：只动表单上的字段，其余原样保留，空值不写", () => {
  const original = {
    api: "openai-completions",
    baseUrl: "https://gw.example/v1",
    apiKey: "$GW_KEY",
    headers: { "X-Team": "eevee" },
    modelOverrides: { other: { contextWindow: 1 } },
    models: [
      {
        id: "m1",
        name: "Model One",
        reasoning: false,
        cost: { input: 1, output: 2 },
        promptCache: { short: 300 },
      },
    ],
  };
  const draft = toDraft(original);
  assert.equal(draft.models[0]?.cost.output, "2");
  draft.name = "  ";
  draft.headers.push({ key: "X-Extra", value: "1" });
  const model = draft.models[0];
  assert.ok(model);
  model.contextWindow = "200k";
  model.image = true;
  model.cost.output = "";
  model.cost.cacheRead = "0.1";
  assert.deepEqual(fromDraft(draft, original), {
    config: {
      api: "openai-completions",
      baseUrl: "https://gw.example/v1",
      apiKey: "$GW_KEY",
      headers: { "X-Team": "eevee", "X-Extra": "1" },
      modelOverrides: { other: { contextWindow: 1 } },
      models: [
        {
          id: "m1",
          name: "Model One",
          reasoning: false,
          cost: { input: 1, cacheRead: 0.1 },
          promptCache: { short: 300 },
          contextWindow: 200_000,
          input: ["text", "image"],
        },
      ],
    },
  });
  assert.deepEqual(fromDraft(toDraft(undefined), undefined), { config: {} });
});

test("写不出去的值指明是哪一个", () => {
  const draft = toDraft({ models: [{ id: "a" }] });
  draft.models.push(emptyModelDraft());
  assert.deepEqual(fromDraft(draft, undefined), { error: { code: "model_id", index: 1 } });
  const second = draft.models[1];
  assert.ok(second);
  second.id = "a";
  assert.deepEqual(fromDraft(draft, undefined), { error: { code: "duplicate_model", id: "a" } });
  second.id = "b";
  second.maxTokens = "many";
  assert.deepEqual(fromDraft(draft, undefined), {
    error: { code: "tokens", model: "b", field: "maxTokens" },
  });
  second.maxTokens = "";
  second.cost.input = "-1";
  assert.deepEqual(fromDraft(draft, undefined), { error: { code: "price", model: "b" } });
});

test("导入端点列出的模型时跳过已有的，带上它声明的字段", () => {
  const draft = toDraft({ models: [{ id: "a" }] });
  const added = addProbed(draft, [
    { id: "a" },
    { id: "b", name: "B", contextWindow: 64_000, input: ["text", "image"], reasoning: true },
  ]);
  assert.equal(added, 1);
  const result = fromDraft(draft, undefined);
  assert.ok("config" in result);
  assert.deepEqual(result.config.models, [
    { id: "a" },
    { id: "b", name: "B", contextWindow: 64_000, reasoning: true, input: ["text", "image"] },
  ]);
});

test("provider id 不能有空格、斜杠或以符号开头", () => {
  assert.ok(isProviderId("my-gw.eu_1"));
  assert.ok(!isProviderId("my gw"));
  assert.ok(!isProviderId("acme/eu"));
  assert.ok(!isProviderId("-x"));
});

const sonnet: BuiltinModelView = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 64_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  costTiers: false,
};

test("内置数据：没设的字段预先勾上，已一致的不能勾，价格从不预先勾选", () => {
  const model = toModelDraft({ id: "claude-sonnet-4-5", maxTokens: 64_000 });
  model.image = true;
  const changes = Object.fromEntries(referenceChanges(model, sonnet).map((c) => [c.field, c]));
  assert.deepEqual(changes.name, { field: "name", same: false, checked: true });
  assert.deepEqual(changes.reasoning, { field: "reasoning", same: false, checked: true });
  assert.deepEqual(changes.image, { field: "image", same: true, checked: false });
  assert.deepEqual(changes.contextWindow, { field: "contextWindow", same: false, checked: true });
  assert.deepEqual(changes.maxTokens, { field: "maxTokens", same: true, checked: false });
  assert.deepEqual(changes.cost, { field: "cost", same: false, checked: false });

  // A field the model already sets otherwise is offered, but left unchecked.
  model.contextWindow = "128k";
  const ctx = referenceChanges(model, sonnet).find((c) => c.field === "contextWindow");
  assert.deepEqual(ctx, { field: "contextWindow", same: false, checked: false });
});

test("内置数据：只复制勾选的字段，token 数按原值写入，id 不变", () => {
  const model = toModelDraft({ id: "anthropic/claude-sonnet-4.5", contextWindow: 128_000 });
  applyReference(model, sonnet, ["name", "contextWindow", "cost"]);
  assert.equal(model.id, "anthropic/claude-sonnet-4.5");
  assert.equal(model.name, "Claude Sonnet 4.5");
  assert.equal(model.contextWindow, "200000");
  assert.equal(model.maxTokens, "");
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.cost, { input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" });
  assert.ok(referenceChanges(model, sonnet).find((c) => c.field === "cost")?.same);

  const result = fromDraft({ ...toDraft(undefined), models: [model] }, undefined);
  assert.ok("config" in result);
  assert.deepEqual(result.config.models?.[0], {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    contextWindow: 200_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  });
});
