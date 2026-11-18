<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type {
  BuiltinModelView,
  ModelsView,
  ProbedModelView,
  ProviderConfigView,
} from "@shared/api/contract.ts";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { errorText } from "../errors.ts";
import { formatTokens, fromRows, isEnvReference } from "../fields.ts";
import { t } from "../i18n.ts";
import {
  API_ENDPOINT,
  API_TYPES,
  addProbed,
  applyReference,
  baseUrlPlaceholder,
  baseUrlShape,
  type DraftError,
  emptyModelDraft,
  fromDraft,
  isProviderId,
  type ModelDraft,
  type ProviderDraft,
  type ReferenceField,
  referenceChanges,
  requestTarget,
  toDraft,
} from "../provider-draft.ts";
import { formatRoute, NEW_ITEM } from "../router.ts";
import { useSubmit } from "../submit.ts";
import { showToast } from "../toasts.ts";
import Icon from "./Icon.vue";
import KeyValueRows from "./KeyValueRows.vue";
import Skeleton from "./Skeleton.vue";

const props = defineProps<{
  client: Client;
  /** The provider's id, or `NEW_ITEM` to add one. */
  id: string;
  view: ModelsView;
  reloadView: () => Promise<void>;
}>();

const LIST = formatRoute({ name: "settings", section: "models" });

const configs = ref<Record<string, ProviderConfigView>>();
const loadError = ref<string>();
const draft = reactive<ProviderDraft>(toDraft(undefined));
const snapshot = ref("");
const newId = ref("");
const keyInput = ref("");
const formError = ref<string>();
const expanded = ref(new Set<string>());
const confirmRemove = ref(false);

const saving = useSubmit();
const removing = useSubmit();
const removingKey = useSubmit();
const probing = useSubmit();
const probed = ref<{ models: ProbedModelView[]; truncated: boolean }>();
const picked = ref(new Set<string>());
const probeFilter = ref("");

const isNew = computed(() => props.id === NEW_ITEM);
const providerId = computed(() => (isNew.value ? newId.value.trim() : props.id));
const provider = computed(() => props.view.providers.find((p) => p.id === props.id));
const builtIn = computed(() => provider.value?.builtIn ?? false);
const original = computed(() => (isNew.value ? undefined : configs.value?.[props.id]));
const missing = computed(
  () => !isNew.value && configs.value !== undefined && !provider.value && !original.value,
);
const dirty = computed(
  () =>
    JSON.stringify(draft) !== snapshot.value ||
    keyInput.value.trim() !== "" ||
    (isNew.value && newId.value.trim() !== ""),
);
const target = computed(() =>
  builtIn.value ? undefined : requestTarget(draft.api || undefined, draft.baseUrl),
);
const apiChoices = computed(() =>
  draft.api !== "" && !(API_TYPES as readonly string[]).includes(draft.api)
    ? [...API_TYPES, draft.api]
    : [...API_TYPES],
);
const title = computed(() =>
  isNew.value ? t("添加 Provider") : (provider.value?.name ?? props.id),
);
const keySaved = computed(() => provider.value?.source === "auth.json");

function reset(config: ProviderConfigView | undefined): void {
  Object.assign(draft, toDraft(config));
  snapshot.value = JSON.stringify(draft);
  keyInput.value = "";
  formError.value = undefined;
  expanded.value = new Set();
  confirmRemove.value = false;
  probed.value = undefined;
  for (const submit of [saving, removing, removingKey, probing]) submit.error.value = undefined;
}

async function loadConfigs(): Promise<void> {
  loadError.value = undefined;
  try {
    configs.value = (await props.client.call("GET /api/models/config")).providers;
  } catch (error) {
    loadError.value = errorText(error);
  }
}

watch(
  () => props.id,
  async () => {
    newId.value = "";
    await loadConfigs();
    reset(original.value);
    if (isNew.value) {
      await nextTick();
      document.querySelector<HTMLInputElement>("#pv-id")?.focus();
    } else if (provider.value && !provider.value.configured) {
      await nextTick();
      document.querySelector<HTMLInputElement>("#pv-key")?.focus();
    }
  },
  { immediate: true },
);

function draftErrorText(error: DraftError): string {
  switch (error.code) {
    case "model_id":
      return t("第 {n} 个模型没有 ID", { n: error.index + 1 });
    case "duplicate_model":
      return t("模型 {model} 重复了", { model: error.id });
    case "tokens":
      return t("{model} 的{field}应为正整数，可以写成 128k", {
        model: error.model,
        field: error.field === "contextWindow" ? t("上下文窗口") : t("最大输出"),
      });
    case "price":
      return t("{model} 的价格应为不小于 0 的数", { model: error.model });
  }
}

/** What stops the form from being written, checked before the Engine sees it. */
function blocker(): string | undefined {
  if (isNew.value) {
    if (!isProviderId(providerId.value)) {
      return t("ID 只能包含字母、数字、.、_ 和 -，并以字母或数字开头");
    }
    if (props.view.providers.some((p) => p.id === providerId.value) || configs.value?.[providerId.value]) {
      return t("已经有 Provider {provider}", { provider: providerId.value });
    }
  }
  if (!builtIn.value) {
    if (draft.api.trim() === "") return t("请选择 API 类型");
    if (draft.baseUrl.trim() === "") return t("请填写 Base URL");
    if (draft.models.length === 0) return t("至少要有一个模型");
  }
  return undefined;
}

async function save(): Promise<void> {
  formError.value = blocker();
  if (formError.value !== undefined) return;
  const result = fromDraft(draft, original.value);
  if ("error" in result) {
    formError.value = draftErrorText(result.error);
    return;
  }
  const id = providerId.value;
  const changed = isNew.value || JSON.stringify(result.config) !== JSON.stringify(original.value ?? {});
  const key = keyInput.value.trim();
  const ok = await saving.run(async () => {
    if (changed) {
      if (Object.keys(result.config).length === 0 && builtIn.value) {
        if (original.value) await props.client.call("DELETE /api/models/providers/:provider", { provider: id });
      } else {
        await props.client.call("PUT /api/models/providers/:provider", { provider: id }, { config: result.config });
      }
    }
    if (key !== "") await props.client.call("POST /api/auth/:provider", { provider: id }, { key });
  });
  if (!ok) return;
  showToast(t("已保存 {provider}", { provider: id }));
  await props.reloadView();
  if (isNew.value) {
    location.hash = formatRoute({ name: "settings", section: "models", item: id });
    return;
  }
  await loadConfigs();
  reset(original.value);
}

function discard(): void {
  if (isNew.value) location.hash = LIST;
  else reset(original.value);
}

async function remove(): Promise<void> {
  const ok = await removing.run(async () => {
    await props.client.call("DELETE /api/models/providers/:provider", { provider: props.id });
  });
  if (!ok) return;
  showToast(builtIn.value ? t("已恢复 {provider} 的内置设置", { provider: props.id }) : t("已删除 {provider}", { provider: props.id }));
  await props.reloadView();
  if (builtIn.value) {
    await loadConfigs();
    reset(original.value);
  } else {
    location.hash = LIST;
  }
}

async function removeKey(): Promise<void> {
  const ok = await removingKey.run(async () => {
    await props.client.call("DELETE /api/auth/:provider", { provider: props.id });
  });
  if (!ok) return;
  showToast(t("已移除 {provider} 保存的 API Key", { provider: props.id }));
  await props.reloadView();
}

// ── Models ───────────────────────────────────────────────────────────────────

function toggleModel(model: ModelDraft): void {
  const next = new Set(expanded.value);
  if (next.has(model.key)) next.delete(model.key);
  else next.add(model.key);
  expanded.value = next;
}

async function addModel(): Promise<void> {
  const model = emptyModelDraft();
  draft.models.push(model);
  expanded.value = new Set([...expanded.value, model.key]);
  await nextTick();
  document.querySelector<HTMLInputElement>(`#pv-model-${model.key}`)?.focus();
}

function removeModel(index: number): void {
  draft.models.splice(index, 1);
}

function modelSummary(model: ModelDraft): string {
  const parts: string[] = [];
  if (model.name.trim()) parts.push(model.name.trim());
  const ctx = Number(model.contextWindow);
  if (model.contextWindow && Number.isFinite(ctx)) parts.push(t("上下文 {tokens}", { tokens: formatTokens(ctx) }));
  if (model.reasoning) parts.push(t("推理"));
  if (model.image) parts.push(t("图片"));
  return parts.join(" · ");
}

// ── Fetching the endpoint's models ───────────────────────────────────────────

const canProbe = computed(() => !builtIn.value && /^https?:\/\//i.test(draft.baseUrl.trim()));
const have = computed(() => new Set(draft.models.map((m) => m.id.trim())));
const probeList = computed(() => {
  const query = probeFilter.value.trim().toLowerCase();
  const models = probed.value?.models ?? [];
  return query === ""
    ? models
    : models.filter((m) => m.id.toLowerCase().includes(query) || m.name?.toLowerCase().includes(query));
});

async function probe(): Promise<void> {
  const key = keyInput.value.trim() || draft.apiKey.trim();
  const headers = fromRows(draft.headers);
  await probing.run(async () => {
    const result = await props.client.call("POST /api/models/probe", {
      ...(providerId.value === "" ? {} : { provider: providerId.value }),
      baseUrl: draft.baseUrl.trim(),
      ...(draft.api === "" ? {} : { api: draft.api }),
      ...(key === "" ? {} : { key }),
      ...(headers === undefined ? {} : { headers }),
    });
    probed.value = result;
    picked.value = new Set();
    probeFilter.value = "";
  });
}

function togglePick(id: string): void {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
}

/** Checks every listed model that can be added, or clears them when all are checked; follows the filter. */
function pickAll(): void {
  const open = probeList.value.filter((m) => !have.value.has(m.id)).map((m) => m.id);
  const all = open.every((id) => picked.value.has(id));
  const next = new Set(picked.value);
  for (const id of open) {
    if (all) next.delete(id);
    else next.add(id);
  }
  picked.value = next;
}

function importPicked(): void {
  const models = (probed.value?.models ?? []).filter((m) => picked.value.has(m.id));
  const added = addProbed(draft, models);
  probed.value = undefined;
  showToast(t("已加入 {n} 个模型，保存后生效", { n: added }));
}

// ── Built-in data ────────────────────────────────────────────────────────────

/** The model whose built-in data panel is open, by key; one at a time. */
const refKey = ref<string>();
const refQuery = ref("");
const refMatches = ref<BuiltinModelView[]>();
const refPicked = ref<BuiltinModelView>();
const refChecked = ref(new Set<ReferenceField>());
const lookingUp = useSubmit();
let lookup = 0;

const refModel = computed(() => draft.models.find((m) => m.key === refKey.value));
const refChanges = computed(() =>
  refModel.value && refPicked.value ? referenceChanges(refModel.value, refPicked.value) : [],
);
const refToApply = computed(() =>
  refChanges.value.filter((c) => !c.same && refChecked.value.has(c.field)).map((c) => c.field),
);

/** The API a model is called with; built-in candidates on it come first. */
const modelApi = (model: ModelDraft) => model.original?.api ?? (draft.api || undefined);

function openReference(model: ModelDraft): void {
  refKey.value = model.key;
  refPicked.value = undefined;
  refMatches.value = undefined;
  refQuery.value = model.id.trim();
  void searchBuiltin();
}

function closeReference(): void {
  refKey.value = undefined;
  refPicked.value = undefined;
}

async function searchBuiltin(): Promise<void> {
  const model = refModel.value;
  const query = refQuery.value.trim();
  const mine = ++lookup;
  if (model === undefined || query === "") {
    refMatches.value = [];
    return;
  }
  const api = modelApi(model);
  await lookingUp.run(async () => {
    const result = await props.client.call("POST /api/models/builtin", {
      query,
      ...(api === undefined ? {} : { api }),
    });
    if (mine === lookup) refMatches.value = result.models;
  });
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
function onRefQuery(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void searchBuiltin(), 150);
}

function pickReference(reference: BuiltinModelView): void {
  const model = refModel.value;
  if (model === undefined) return;
  refPicked.value = reference;
  refChecked.value = new Set(
    referenceChanges(model, reference)
      .filter((c) => c.checked)
      .map((c) => c.field),
  );
}

function toggleReferenceField(field: ReferenceField): void {
  const next = new Set(refChecked.value);
  if (next.has(field)) next.delete(field);
  else next.add(field);
  refChecked.value = next;
}

function applyPicked(): void {
  const model = refModel.value;
  const reference = refPicked.value;
  if (model === undefined || reference === undefined) return;
  const fields = refToApply.value;
  applyReference(model, reference, fields);
  showToast(
    t("已从 {model} 复制 {n} 项，保存后生效", {
      model: `${reference.provider}/${reference.id}`,
      n: fields.length,
    }),
  );
  closeReference();
}

function candidateMeta(reference: BuiltinModelView, model: ModelDraft): string {
  const parts = [
    t("上下文 {tokens}", { tokens: formatTokens(reference.contextWindow) }),
    t("输出 {tokens}", { tokens: formatTokens(reference.maxTokens) }),
  ];
  if (reference.input.includes("image")) parts.push(t("图片"));
  if (reference.reasoning) parts.push(t("推理"));
  const api = modelApi(model);
  if (api !== undefined && reference.api !== api) parts.push(reference.api);
  return parts.join(" · ");
}

const FIELD_LABEL: Record<ReferenceField, () => string> = {
  name: () => t("名称"),
  reasoning: () => t("推理"),
  image: () => t("图片输入"),
  contextWindow: () => t("上下文窗口"),
  maxTokens: () => t("最大输出"),
  cost: () => t("价格（美元 / 百万 token）"),
};

const yesNo = (on: boolean) => (on ? t("是") : t("否"));
const rates = (cost: Record<"input" | "output" | "cacheRead" | "cacheWrite", string | number>) =>
  [cost.input, cost.output, cost.cacheRead, cost.cacheWrite]
    .map((v) => (v === "" ? "0" : String(v)))
    .join(" / ");

function currentText(model: ModelDraft, field: ReferenceField): string {
  switch (field) {
    case "name":
      return model.name.trim() || t("未设置，用 ID");
    case "reasoning":
      return yesNo(model.reasoning);
    case "image":
      return yesNo(model.image);
    case "contextWindow":
      return model.contextWindow.trim() || t("未设置，默认 {tokens}", { tokens: "128k" });
    case "maxTokens":
      return model.maxTokens.trim() || t("未设置，默认 {tokens}", { tokens: "16k" });
    case "cost":
      return Object.values(model.cost).every((v) => v.trim() === "") ? t("未设置") : rates(model.cost);
  }
}

function referenceText(reference: BuiltinModelView, field: ReferenceField): string {
  switch (field) {
    case "name":
      return reference.name;
    case "reasoning":
      return yesNo(reference.reasoning);
    case "image":
      return yesNo(reference.input.includes("image"));
    case "contextWindow":
      return formatTokens(reference.contextWindow);
    case "maxTokens":
      return formatTokens(reference.maxTokens);
    case "cost":
      return rates(reference.cost);
  }
}

function probedMeta(model: ProbedModelView): string {
  const parts: string[] = [];
  if (model.name) parts.push(model.name);
  if (model.contextWindow) parts.push(t("上下文 {tokens}", { tokens: formatTokens(model.contextWindow) }));
  if (model.maxTokens) parts.push(t("输出 {tokens}", { tokens: formatTokens(model.maxTokens) }));
  if (model.input?.includes("image")) parts.push(t("图片"));
  if (model.reasoning) parts.push(t("推理"));
  return parts.join(" · ");
}
</script>

<template>
  <header class="set-head">
    <a class="btn ghost sm icon" :href="LIST" :aria-label="t('返回 Provider 列表')">
      <Icon name="chevL" size="sm" />
    </a>
    <h2 class="ellipsis">{{ title }}</h2>
    <template v-if="!isNew && !missing && configs !== undefined">
      <span class="chip">{{ builtIn ? t("内置") : t("自定义") }}</span>
    </template>
    <template v-if="!isNew && !missing && configs !== undefined && (original || !builtIn)">
      <template v-if="confirmRemove">
        <button type="button" class="btn sm danger" :disabled="removing.busy.value" @click="remove">
          {{ builtIn ? t("确认恢复") : t("确认删除") }}
        </button>
        <button type="button" class="btn ghost sm" @click="confirmRemove = false">{{ t("取消") }}</button>
      </template>
      <button v-else type="button" class="btn ghost sm danger" @click="confirmRemove = true">
        <Icon :name="builtIn ? 'undo' : 'x'" size="xs" />
        <span>{{ builtIn ? t("恢复内置设置") : t("删除") }}</span>
      </button>
    </template>
  </header>

  <p v-if="loadError" class="error hint">{{ loadError }}</p>
  <p v-else-if="removing.error.value" class="error hint">{{ removing.error.value }}</p>
  <Skeleton v-if="configs === undefined && !loadError" />
  <div v-else-if="missing" class="empty">
    <h3>{{ t("找不到 Provider {provider}", { provider: id }) }}</h3>
    <a class="btn sm" :href="LIST">{{ t("返回 Provider 列表") }}</a>
  </div>
  <form v-else-if="configs" class="pv-form" @submit.prevent="save">
    <div class="section-t"><h3>{{ t("连接") }}</h3></div>
    <div class="rows">
      <div v-if="isNew" class="f-row">
        <label for="pv-id">ID</label>
        <div class="f-ctrl">
          <input
            id="pv-id"
            v-model="newId"
            class="input mono"
            spellcheck="false"
            autocomplete="off"
            placeholder="my-gateway"
          />
        </div>
      </div>
      <div v-if="!builtIn" class="f-row">
        <label for="pv-api">{{ t("API 类型") }}</label>
        <div class="f-ctrl">
          <select id="pv-api" v-model="draft.api" class="input mono">
            <option value="" disabled>{{ t("选择接口协议") }}</option>
            <option v-for="api in apiChoices" :key="api" :value="api">
              {{ API_ENDPOINT[api] ? `${api} · ${API_ENDPOINT[api]}` : api }}
            </option>
          </select>
        </div>
      </div>
      <div class="f-row">
        <label for="pv-base">Base URL</label>
        <div class="f-ctrl">
          <input
            id="pv-base"
            v-model="draft.baseUrl"
            class="input mono"
            spellcheck="false"
            autocomplete="off"
            :placeholder="builtIn ? (provider?.defaultBaseUrl ?? '') : baseUrlPlaceholder(draft.api || undefined)"
          />
          <span v-if="target" class="f-note mono" :class="{ warn: target.doubled }">
            {{
              target.doubled
                ? t("请求发往 {url}，/v1 重复了，从 Base URL 去掉", { url: target.url })
                : t("请求发往 {url}", { url: target.url })
            }}
          </span>
          <span v-else-if="!builtIn && baseUrlShape(draft.api || undefined) === 'origin'" class="f-note">
            {{ t("只写域名，客户端会加上 /v1") }}
          </span>
          <span v-else-if="!builtIn && baseUrlShape(draft.api || undefined)" class="f-note">
            {{ t("包含版本路径，比如 /v1") }}
          </span>
        </div>
      </div>
      <div class="f-row">
        <label for="pv-key">API Key</label>
        <div class="f-ctrl">
          <div class="f-inline">
            <input
              id="pv-key"
              v-model="keyInput"
              class="input mono"
              type="password"
              spellcheck="false"
              autocomplete="off"
              :placeholder="keySaved ? t('已保存，输入新的 Key 替换') : t('粘贴 API Key')"
            />
            <button
              v-if="keySaved && !isNew"
              type="button"
              class="btn ghost sm"
              :disabled="removingKey.busy.value"
              @click="removeKey"
            >
              {{ t("移除") }}
            </button>
          </div>
          <span v-if="provider?.authType === 'oauth'" class="f-note">{{ t("已通过 OAuth 登录") }}</span>
          <span v-else-if="provider?.configured && !keySaved && provider.source" class="f-note">
            {{ t("当前凭据来自 {source}", { source: provider.source }) }}
          </span>
          <span v-if="removingKey.error.value" class="f-note warn">{{ removingKey.error.value }}</span>
        </div>
      </div>
    </div>

    <div class="section-t">
      <h3>{{ builtIn ? t("追加的模型") : t("模型::list") }}</h3>
      <span class="count">{{ draft.models.length }}</span>
      <span class="spacer" />
      <button v-if="!builtIn" type="button" class="btn sm" :disabled="!canProbe || probing.busy.value" @click="probe">
        <Icon name="refresh" size="xs" :spin="probing.busy.value" />
        <span>{{ t("从端点获取") }}</span>
      </button>
      <button type="button" class="btn sm" @click="addModel">
        <Icon name="plus" size="xs" />
        <span>{{ t("添加模型") }}</span>
      </button>
    </div>
    <p v-if="probing.error.value" class="error hint">{{ probing.error.value }}</p>

    <div v-if="probed" class="rows probe">
      <div class="row probe-head">
        <input
          v-if="probed.models.length > 8"
          v-model="probeFilter"
          class="input pref"
          :placeholder="t('筛选')"
          :aria-label="t('筛选端点列出的模型')"
        />
        <span v-else class="r-d spacer">{{ t("端点列出 {n} 个模型", { n: probed.models.length }) }}</span>
        <span class="spacer" />
        <button type="button" class="btn ghost sm" :disabled="probeList.length === 0" @click="pickAll">
          {{ t("全选") }}
        </button>
        <button type="button" class="btn sm primary" :disabled="picked.size === 0" @click="importPicked">
          {{ t("加入 {n} 个", { n: picked.size }) }}
        </button>
        <button type="button" class="btn ghost sm icon" :aria-label="t('关闭')" @click="probed = undefined">
          <Icon name="x" size="xs" />
        </button>
      </div>
      <div class="probe-list">
        <label
          v-for="model in probeList"
          :key="model.id"
          class="row pick"
          :class="{ off: have.has(model.id) }"
        >
          <input
            type="checkbox"
            :checked="have.has(model.id) || picked.has(model.id)"
            :disabled="have.has(model.id)"
            @change="togglePick(model.id)"
          />
          <span class="r-main">
            <span class="r-t mono">{{ model.id }}</span>
            <span v-if="probedMeta(model)" class="r-d">{{ probedMeta(model) }}</span>
          </span>
          <span v-if="have.has(model.id)" class="r-d">{{ t("已添加") }}</span>
        </label>
        <div v-if="probeList.length === 0" class="row"><span class="muted">{{ t("没有匹配的模型") }}</span></div>
      </div>
      <div v-if="probed.truncated" class="row"><span class="r-d">{{ t("端点还有更多模型没有列出") }}</span></div>
    </div>

    <div v-if="draft.models.length > 0" class="rows">
      <div v-for="(model, index) in draft.models" :key="model.key" class="m-item">
        <div class="row m-head">
          <button
            type="button"
            class="m-toggle"
            :aria-expanded="expanded.has(model.key)"
            @click="toggleModel(model)"
          >
            <Icon :name="expanded.has(model.key) ? 'chevD' : 'chevR'" size="xs" />
            <span class="mono ellipsis">{{ model.id || t("新模型") }}</span>
            <span class="r-d ellipsis">{{ modelSummary(model) }}</span>
          </button>
          <button
            type="button"
            class="btn ghost sm icon"
            :aria-label="t('删除模型 {model}', { model: model.id || t('新模型') })"
            @click="removeModel(index)"
          >
            <Icon name="x" size="xs" />
          </button>
        </div>
        <div v-if="expanded.has(model.key)" class="m-fields">
          <div v-if="refKey !== model.key" class="m-ref-bar">
            <button type="button" class="btn sm" :disabled="model.id.trim() === ''" @click="openReference(model)">
              <Icon name="copy" size="xs" />
              <span>{{ t("使用内置数据") }}</span>
            </button>
            <span class="f-note">{{ t("从内置模型复制名称、上下文、价格等，不用手动填写") }}</span>
          </div>
          <div v-else class="rows m-ref">
            <template v-if="refPicked === undefined">
              <div class="row m-ref-head">
                <input
                  v-model="refQuery"
                  class="input mono"
                  spellcheck="false"
                  autocomplete="off"
                  :placeholder="t('搜索内置模型')"
                  :aria-label="t('搜索内置模型')"
                  @input="onRefQuery"
                />
                <button type="button" class="btn ghost sm icon" :aria-label="t('关闭')" @click="closeReference">
                  <Icon name="x" size="xs" />
                </button>
              </div>
              <div v-if="lookingUp.error.value" class="row"><span class="error">{{ lookingUp.error.value }}</span></div>
              <button
                v-for="reference in refMatches ?? []"
                :key="`${reference.provider}/${reference.id}`"
                type="button"
                class="row pick"
                @click="pickReference(reference)"
              >
                <span class="r-main">
                  <span class="r-t mono ellipsis">{{ reference.provider }} / {{ reference.id }}</span>
                  <span class="r-d">{{ candidateMeta(reference, model) }}</span>
                </span>
                <Icon name="chevR" size="xs" class="go" />
              </button>
              <div v-if="refMatches?.length === 0" class="row">
                <span class="muted">{{ t("没有相近的内置模型，继续手动填写") }}</span>
              </div>
            </template>
            <template v-else>
              <div class="row m-ref-head">
                <button type="button" class="btn ghost sm icon" :aria-label="t('返回候选列表')" @click="refPicked = undefined">
                  <Icon name="chevL" size="xs" />
                </button>
                <span class="r-main">
                  <span class="r-t mono ellipsis">{{ refPicked.provider }} / {{ refPicked.id }}</span>
                  <span class="r-d">{{ t("勾选要复制的字段，模型 ID 和接口保持不变") }}</span>
                </span>
              </div>
              <label
                v-for="change in refChanges"
                :key="change.field"
                class="row pick"
                :class="{ off: change.same }"
              >
                <input
                  type="checkbox"
                  :checked="!change.same && refChecked.has(change.field)"
                  :disabled="change.same"
                  @change="toggleReferenceField(change.field)"
                />
                <span class="r-main">
                  <span class="r-t">{{ FIELD_LABEL[change.field]() }}</span>
                  <span v-if="change.same" class="r-d">{{ referenceText(refPicked, change.field) }} · {{ t("已一致") }}</span>
                  <span v-else class="r-d">
                    {{ currentText(model, change.field) }} → <span class="m-ref-new">{{ referenceText(refPicked, change.field) }}</span>
                  </span>
                  <span v-if="change.field === 'cost' && refPicked.costTiers" class="r-d">
                    {{ t("它还按输入长度分档计价，分档不会复制") }}
                  </span>
                </span>
              </label>
              <div class="row m-ref-foot">
                <span class="spacer" />
                <button type="button" class="btn ghost sm" @click="closeReference">{{ t("取消") }}</button>
                <button type="button" class="btn sm primary" :disabled="refToApply.length === 0" @click="applyPicked">
                  {{ t("复制 {n} 项", { n: refToApply.length }) }}
                </button>
              </div>
            </template>
          </div>
          <div class="field">
            <label :for="`pv-model-${model.key}`">ID</label>
            <input :id="`pv-model-${model.key}`" v-model="model.id" class="input mono" spellcheck="false" autocomplete="off" />
          </div>
          <div class="field">
            <label :for="`pv-mname-${model.key}`">{{ t("名称") }}</label>
            <input :id="`pv-mname-${model.key}`" v-model="model.name" class="input" autocomplete="off" :placeholder="model.id" />
          </div>
          <div class="field">
            <label :for="`pv-ctx-${model.key}`">{{ t("上下文窗口") }}</label>
            <input :id="`pv-ctx-${model.key}`" v-model="model.contextWindow" class="input mono" placeholder="128k" />
          </div>
          <div class="field">
            <label :for="`pv-max-${model.key}`">{{ t("最大输出") }}</label>
            <input :id="`pv-max-${model.key}`" v-model="model.maxTokens" class="input mono" placeholder="16k" />
          </div>
          <div class="field toggles">
            <label class="toggle">
              <button
                type="button"
                class="switch"
                :class="{ on: model.reasoning }"
                :aria-pressed="model.reasoning"
                @click="model.reasoning = !model.reasoning"
              />
              <span>{{ t("推理") }}</span>
            </label>
            <label class="toggle">
              <button
                type="button"
                class="switch"
                :class="{ on: model.image }"
                :aria-pressed="model.image"
                @click="model.image = !model.image"
              />
              <span>{{ t("图片输入") }}</span>
            </label>
          </div>
          <fieldset class="field prices">
            <legend>{{ t("价格（美元 / 百万 token）") }}</legend>
            <input v-model="model.cost.input" class="input mono" inputmode="decimal" :placeholder="t('输入')" :aria-label="t('输入价格')" />
            <input v-model="model.cost.output" class="input mono" inputmode="decimal" :placeholder="t('输出')" :aria-label="t('输出价格')" />
            <input v-model="model.cost.cacheRead" class="input mono" inputmode="decimal" :placeholder="t('缓存读')" :aria-label="t('缓存读价格')" />
            <input v-model="model.cost.cacheWrite" class="input mono" inputmode="decimal" :placeholder="t('缓存写')" :aria-label="t('缓存写价格')" />
          </fieldset>
        </div>
      </div>
    </div>

    <details class="f-adv">
      <summary>{{ t("高级") }}</summary>
      <div class="rows">
        <div class="f-row">
          <label for="pv-name">{{ t("显示名称") }}</label>
          <div class="f-ctrl">
            <input id="pv-name" v-model="draft.name" class="input" autocomplete="off" :placeholder="providerId" />
            <span class="f-note">{{ t("只用于显示，留空时显示 ID") }}</span>
          </div>
        </div>
        <div class="f-row top">
          <span class="f-label">{{ t("请求头") }}</span>
          <KeyValueRows :rows="draft.headers" :label="t('请求头')" key-placeholder="X-Header" value-placeholder="$ENV_NAME" />
        </div>
        <div class="f-row">
          <span class="f-label">authHeader</span>
          <label class="toggle">
            <button
              type="button"
              class="switch"
              :class="{ on: draft.authHeader }"
              :aria-pressed="draft.authHeader"
              @click="draft.authHeader = !draft.authHeader"
            />
            <span>{{ t("另以 Authorization: Bearer 发送 Key") }}</span>
          </label>
        </div>
        <div class="f-row">
          <label for="pv-apikey">apiKey</label>
          <div class="f-ctrl">
            <input
              id="pv-apikey"
              v-model="draft.apiKey"
              class="input mono"
              :type="draft.apiKey === '' || isEnvReference(draft.apiKey) ? 'text' : 'password'"
              spellcheck="false"
              autocomplete="off"
              placeholder="$ENV_NAME"
            />
            <span class="f-note">{{ t("写进 models.json，可以引用环境变量；上面保存的 Key 优先") }}</span>
          </div>
        </div>
      </div>
    </details>

    <footer class="f-foot">
      <span v-if="formError || saving.error.value" class="error" role="alert">{{ formError ?? saving.error.value }}</span>
      <span class="spacer" />
      <button type="button" class="btn ghost sm" :disabled="!dirty && !isNew" @click="discard">
        {{ isNew ? t("取消") : t("放弃更改") }}
      </button>
      <button type="submit" class="btn sm primary" :disabled="(!dirty && !isNew) || saving.busy.value">
        {{ isNew ? t("添加") : t("保存") }}
      </button>
    </footer>
  </form>
</template>
