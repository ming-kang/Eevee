<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type {
  BuiltinModelView,
  ModelsView,
  ProbedModelView,
  ProviderConfigView,
} from "@shared/protocol/contract.ts";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { errorText } from "../../lib/errors.ts";
import { formatTokens, fromRows, isEnvReference } from "../../lib/fields.ts";
import { t } from "../../lib/i18n.ts";
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
} from "../../lib/provider-draft.ts";
import { formatRoute, NEW_ITEM } from "../../lib/router.ts";
import { useSubmit } from "../../composables/submit.ts";
import { showToast } from "../../composables/toasts.ts";
import Icon from "../../ui/Icon.vue";
import KeyValueRows from "../../ui/KeyValueRows.vue";
import Skeleton from "../../ui/Skeleton.vue";
import Button from "../../ui/Button.vue";
import Input from "../../ui/Input.vue";
import Switch from "../../ui/Switch.vue";
import { fieldClass } from "../../ui/field.ts";
import SectionHeader from "../../ui/SectionHeader.vue";
import { badge, EMPTY } from "../../ui/surface.ts";
import { ROW_DESC, ROW_PICK, row, rowMain, rowTitle, rows } from "../../ui/rows.ts";
import { DISCLOSURE, FIELD, FIELD_CTRL, FIELD_INLINE, FIELD_NOTE, FORM, FORM_FOOT, FORM_LABEL, SECTION_T, TOGGLE, formRow } from "../../ui/form.ts";

const props = defineProps<{
  client: Client;
  /** The provider's id, or `NEW_ITEM` to add one. */
  id: string;
  view: ModelsView;
  reloadView: () => Promise<void>;
}>();

const LIST = formatRoute({ name: "control", section: "models" });

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
  isNew.value ? t("Add provider") : (provider.value?.name ?? props.id),
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
      return t("Model {n} has no ID", { n: error.index + 1 });
    case "duplicate_model":
      return t("Model {model} is listed twice", { model: error.id });
    case "tokens":
      return t("{field} of {model} must be a positive whole number, such as 128k", {
        model: error.model,
        field: error.field === "contextWindow" ? t("Context window") : t("Max output"),
      });
    case "price":
      return t("Prices for {model} must be 0 or more", { model: error.model });
  }
}

/** What stops the form from being written, checked before the Engine sees it. */
function blocker(): string | undefined {
  if (isNew.value) {
    if (!isProviderId(providerId.value)) {
      return t("IDs may contain only letters, digits, ., _ and -, and start with a letter or digit");
    }
    if (props.view.providers.some((p) => p.id === providerId.value) || configs.value?.[providerId.value]) {
      return t("There is already a provider named {provider}", { provider: providerId.value });
    }
  }
  if (!builtIn.value) {
    if (draft.api.trim() === "") return t("Select an API type");
    if (draft.baseUrl.trim() === "") return t("Enter a base URL");
    if (draft.models.length === 0) return t("Add at least one model to the provider");
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
    if (key !== "") await props.client.call("PUT /api/models/providers/:provider/credentials", { provider: id }, { key });
  });
  if (!ok) return;
  showToast(t("Saved {provider}", { provider: id }));
  await props.reloadView();
  if (isNew.value) {
    location.hash = formatRoute({ name: "control", section: "models", item: id });
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
  showToast(builtIn.value ? t("Restored the built-in settings of {provider}", { provider: props.id }) : t("Deleted {provider}", { provider: props.id }));
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
    await props.client.call("DELETE /api/models/providers/:provider/credentials", { provider: props.id });
  });
  if (!ok) return;
  showToast(t("Removed the saved {provider} API key", { provider: props.id }));
  await props.reloadView();
}

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
  if (model.contextWindow && Number.isFinite(ctx)) parts.push(t("{tokens} context", { tokens: formatTokens(ctx) }));
  if (model.reasoning) parts.push(t("Reasoning"));
  if (model.image) parts.push(t("Images"));
  return parts.join(" · ");
}

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
  showToast(t("Added {n} model; save to apply|Added {n} models; save to apply", { n: added }));
}

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
    const result = await props.client.call("POST /api/models/builtin/search", {
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
    t("Copied {n} field from {model}; save to apply|Copied {n} fields from {model}; save to apply", {
      model: `${reference.provider}/${reference.id}`,
      n: fields.length,
    }),
  );
  closeReference();
}

function candidateMeta(reference: BuiltinModelView, model: ModelDraft): string {
  const parts = [
    t("{tokens} context", { tokens: formatTokens(reference.contextWindow) }),
    t("{tokens} output", { tokens: formatTokens(reference.maxTokens) }),
  ];
  if (reference.input.includes("image")) parts.push(t("Images"));
  if (reference.reasoning) parts.push(t("Reasoning"));
  const api = modelApi(model);
  if (api !== undefined && reference.api !== api) parts.push(reference.api);
  return parts.join(" · ");
}

const FIELD_LABEL: Record<ReferenceField, () => string> = {
  name: () => t("Name"),
  reasoning: () => t("Reasoning"),
  image: () => t("Image input"),
  contextWindow: () => t("Context window"),
  maxTokens: () => t("Max output"),
  cost: () => t("Price (USD per million tokens)"),
};

const yesNo = (on: boolean) => (on ? t("Yes") : t("No"));
const rates = (cost: Record<"input" | "output" | "cacheRead" | "cacheWrite", string | number>) =>
  [cost.input, cost.output, cost.cacheRead, cost.cacheWrite]
    .map((v) => (v === "" ? "0" : String(v)))
    .join(" / ");

function currentText(model: ModelDraft, field: ReferenceField): string {
  switch (field) {
    case "name":
      return model.name.trim() || t("Not set; uses the ID");
    case "reasoning":
      return yesNo(model.reasoning);
    case "image":
      return yesNo(model.image);
    case "contextWindow":
      return model.contextWindow.trim() || t("Not set; defaults to {tokens}", { tokens: "128k" });
    case "maxTokens":
      return model.maxTokens.trim() || t("Not set; defaults to {tokens}", { tokens: "16k" });
    case "cost":
      return Object.values(model.cost).every((v) => v.trim() === "") ? t("Not set") : rates(model.cost);
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
  if (model.contextWindow) parts.push(t("{tokens} context", { tokens: formatTokens(model.contextWindow) }));
  if (model.maxTokens) parts.push(t("{tokens} output", { tokens: formatTokens(model.maxTokens) }));
  if (model.input?.includes("image")) parts.push(t("Images"));
  if (model.reasoning) parts.push(t("Reasoning"));
  return parts.join(" · ");
}
</script>

<template>
  <SectionHeader :title="title">
    <template #leading>
      <Button variant="ghost" size="sm" icon :href="LIST" :aria-label="t('Back to providers')">
        <Icon name="chevL" size="sm" />
      </Button>
    </template>
    <template v-if="!isNew && !missing && configs !== undefined">
      <span :class="badge()">{{ builtIn ? t("Built-in") : t("Custom") }}</span>
    </template>
    <template v-if="!isNew && !missing && configs !== undefined && (original || !builtIn)">
      <template v-if="confirmRemove">
        <Button variant="danger" size="sm" :disabled="removing.busy.value" @click="remove">
          {{ builtIn ? t("Confirm restore") : t("Confirm delete") }}
        </Button>
        <Button variant="ghost" size="sm" @click="confirmRemove = false">{{ t("Cancel") }}</Button>
      </template>
      <Button v-else variant="ghost-danger" size="sm" @click="confirmRemove = true">
        <Icon :name="builtIn ? 'undo' : 'x'" size="xs" />
        <span>{{ builtIn ? t("Restore built-in settings") : t("Delete") }}</span>
      </Button>
    </template>
  </SectionHeader>

  <p v-if="loadError" class="error hint">{{ loadError }}</p>
  <p v-else-if="removing.error.value" class="error hint">{{ removing.error.value }}</p>
  <Skeleton v-if="configs === undefined && !loadError" />
  <div v-else-if="missing" :class="EMPTY">
    <h3>{{ t("No provider named {provider}", { provider: id }) }}</h3>
    <Button size="sm" :href="LIST">{{ t("Back to providers") }}</Button>
  </div>
  <form v-else-if="configs" :class="FORM" @submit.prevent="save">
    <div :class="SECTION_T"><h3>{{ t("Connection") }}</h3></div>
    <div :class="rows()">
      <div :class="formRow()" v-if="isNew">
        <label for="pv-id">ID</label>
        <div :class="FIELD_CTRL">
          <Input id="pv-id" v-model="newId" mono spellcheck="false" autocomplete="off" placeholder="my-gateway" />
        </div>
      </div>
      <div :class="formRow()" v-if="!builtIn">
        <label for="pv-api">{{ t("API type") }}</label>
        <div :class="FIELD_CTRL">
          <select id="pv-api" v-model="draft.api" class="pr-7" :class="fieldClass({ mono: true })">
            <option value="" disabled>{{ t("Select an API type") }}</option>
            <option v-for="api in apiChoices" :key="api" :value="api">
              {{ API_ENDPOINT[api] ? `${api} · ${API_ENDPOINT[api]}` : api }}
            </option>
          </select>
        </div>
      </div>
      <div :class="formRow()">
        <label for="pv-base">Base URL</label>
        <div :class="FIELD_CTRL">
          <Input id="pv-base" v-model="draft.baseUrl" mono spellcheck="false" autocomplete="off" :placeholder="builtIn ? (provider?.defaultBaseUrl ?? '') : baseUrlPlaceholder(draft.api || undefined)" />
          <span v-if="target" class="mono" :class="[FIELD_NOTE, { warn: target.doubled }]">
            {{
              target.doubled
                ? t("Requests go to {url}; /v1 is doubled, remove it from the base URL", { url: target.url })
                : t("Requests go to {url}", { url: target.url })
            }}
          </span>
          <span :class="FIELD_NOTE" v-else-if="!builtIn && baseUrlShape(draft.api || undefined) === 'origin'">
            {{ t("Just the origin; the client adds /v1") }}
          </span>
          <span :class="FIELD_NOTE" v-else-if="!builtIn && baseUrlShape(draft.api || undefined)">
            {{ t("Include the version path, such as /v1") }}
          </span>
        </div>
      </div>
      <div :class="formRow()">
        <label for="pv-key">API Key</label>
        <div :class="FIELD_CTRL">
          <div :class="FIELD_INLINE">
            <Input id="pv-key" v-model="keyInput" mono type="password" spellcheck="false" autocomplete="off" :placeholder="keySaved ? t('Saved; type a new key to replace it') : t('Paste an API key')" />
            <Button v-if="keySaved && !isNew" variant="ghost" size="sm" :disabled="removingKey.busy.value" @click="removeKey">
              {{ t("Remove") }}
            </Button>
          </div>
          <span :class="FIELD_NOTE" v-if="provider?.authType === 'oauth'">{{ t("Signed in with OAuth") }}</span>
          <span :class="FIELD_NOTE" v-else-if="provider?.configured && !keySaved && provider.source">
            {{ t("Credentials come from {source}", { source: provider.source }) }}
          </span>
          <span :class="FIELD_NOTE" v-if="removingKey.error.value" class="warn">{{ removingKey.error.value }}</span>
        </div>
      </div>
    </div>

    <div :class="SECTION_T">
      <h3>{{ builtIn ? t("Added models") : t("Models") }}</h3>
      <span class="count">{{ draft.models.length }}</span>
      <span class="spacer" />
      <Button v-if="!builtIn" size="sm" :disabled="!canProbe || probing.busy.value" @click="probe">
        <Icon name="refresh" size="xs" :spin="probing.busy.value" />
        <span>{{ t("Fetch from endpoint") }}</span>
      </Button>
      <Button size="sm" @click="addModel">
        <Icon name="plus" size="xs" />
        <span>{{ t("Add model") }}</span>
      </Button>
    </div>
    <p v-if="probing.error.value" class="error hint">{{ probing.error.value }}</p>

    <div v-if="probed" class="animate-[ev-rise_var(--ev-regular)_var(--ev-ease)]" :class="rows()">
      <div class="min-h-13 gap-2 px-4 py-2.5" :class="row({ size: 'none' })">
        <Input v-if="probed.models.length > 8" v-model="probeFilter" size="sm" class="w-55" :placeholder="t('Filter')" :aria-label="t('Filter the endpoint\'s models')" />
        <span v-else class="spacer" :class="ROW_DESC">{{ t("The endpoint lists {n} model|The endpoint lists {n} models", { n: probed.models.length }) }}</span>
        <span class="spacer" />
        <Button variant="ghost" size="sm" :disabled="probeList.length === 0" @click="pickAll">
          {{ t("Select all") }}
        </Button>
        <Button variant="primary" size="sm" :disabled="picked.size === 0" @click="importPicked">
          {{ t("Add {n} model|Add {n} models", { n: picked.size }) }}
        </Button>
        <Button variant="ghost" size="sm" icon :aria-label="t('Close')" @click="probed = undefined">
          <Icon name="x" size="xs" />
        </Button>
      </div>
      <div class="max-h-80 overflow-y-auto">
        <label
          v-for="model in probeList"
          :key="model.id"
          
          :class="[ROW_PICK, { off: have.has(model.id) }]"
        >
          <input
            type="checkbox"
            :checked="have.has(model.id) || picked.has(model.id)"
            :disabled="have.has(model.id)"
            @change="togglePick(model.id)"
          />
          <span :class="rowMain()">
            <span class="mono" :class="rowTitle()">{{ model.id }}</span>
            <span v-if="probedMeta(model)" :class="ROW_DESC">{{ probedMeta(model) }}</span>
          </span>
          <span v-if="have.has(model.id)" :class="ROW_DESC">{{ t("Added") }}</span>
        </label>
        <div v-if="probeList.length === 0" :class="row()"><span class="muted">{{ t("No models match") }}</span></div>
      </div>
      <div v-if="probed.truncated" :class="row()"><span :class="ROW_DESC">{{ t("The endpoint has more models than it listed") }}</span></div>
    </div>

    <div v-if="draft.models.length > 0" :class="rows()">
      <div v-for="(model, index) in draft.models" :key="model.key" class="m-item">
        <div class="min-h-11 gap-3 py-1 pr-2 pl-2.5" :class="row({ size: 'none' })">
          <button
            type="button"
            class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-hover focus-visible:shadow-(--ring) focus-visible:outline-none"
            :aria-expanded="expanded.has(model.key)"
            @click="toggleModel(model)"
          >
            <Icon :name="expanded.has(model.key) ? 'chevD' : 'chevR'" size="xs" />
            <span class="mono ellipsis">{{ model.id || t("New model") }}</span>
            <span class="ellipsis min-w-0 flex-1" :class="ROW_DESC">{{ modelSummary(model) }}</span>
          </button>
          <Button variant="ghost" size="sm" icon :aria-label="t('Remove model {model}', { model: model.id || t('New model') })" @click="removeModel(index)">
            <Icon name="x" size="xs" />
          </Button>
        </div>
        <div v-if="expanded.has(model.key)" class="grid animate-[ev-fade_var(--ev-regular)_var(--ev-ease)] grid-cols-2 gap-x-4 gap-y-3 pt-1 pr-4 pb-4 pl-9 @max-[44.2857em]/vp:grid-cols-1 @max-[44.2857em]/vp:pl-4">
          <div v-if="refKey !== model.key" class="col-span-full flex min-w-0 items-center gap-2.5">
            <Button size="sm" :disabled="model.id.trim() === ''" @click="openReference(model)">
              <Icon name="copy" size="xs" />
              <span>{{ t("Use built-in data") }}</span>
            </Button>
            <span :class="FIELD_NOTE">{{ t("Copy the name, context, prices and more from a built-in model") }}</span>
          </div>
          <div v-else class="m-ref col-span-full flex flex-col overflow-hidden rounded-lg border border-border bg-sidebar [--ev-glyph-cut:var(--bg-sidebar)] animate-[ev-rise_var(--ev-regular)_var(--ev-ease)] [&>*+*]:border-t [&>*+*]:border-separator">
            <template v-if="refPicked === undefined">
              <div class="min-h-13 gap-2 py-1.5 pr-2 pl-3" :class="row({ size: 'none' })">
                <Input v-model="refQuery" mono class="min-w-0 flex-1" spellcheck="false" autocomplete="off" :placeholder="t('Search built-in models')" :aria-label="t('Search built-in models')" @input="onRefQuery" />
                <Button variant="ghost" size="sm" icon :aria-label="t('Close')" @click="closeReference">
                  <Icon name="x" size="xs" />
                </Button>
              </div>
              <div v-if="lookingUp.error.value" :class="row()"><span class="error">{{ lookingUp.error.value }}</span></div>
              <button
                v-for="reference in refMatches ?? []"
                :key="`${reference.provider}/${reference.id}`"
                type="button"
                :class="ROW_PICK"
                @click="pickReference(reference)"
              >
                <span :class="rowMain()">
                  <span class="mono ellipsis" :class="rowTitle()">{{ reference.provider }} / {{ reference.id }}</span>
                  <span :class="ROW_DESC">{{ candidateMeta(reference, model) }}</span>
                </span>
                <Icon name="chevR" size="xs" class="go" />
              </button>
              <div v-if="refMatches?.length === 0" :class="row()">
                <span class="muted">{{ t("No similar built-in model; keep filling it in by hand") }}</span>
              </div>
            </template>
            <template v-else>
              <div class="min-h-13 gap-2 py-1.5 pr-2 pl-3" :class="row({ size: 'none' })">
                <Button variant="ghost" size="sm" icon :aria-label="t('Back to candidates')" @click="refPicked = undefined">
                  <Icon name="chevL" size="xs" />
                </Button>
                <span :class="rowMain()">
                  <span class="mono ellipsis" :class="rowTitle()">{{ refPicked.provider }} / {{ refPicked.id }}</span>
                  <span :class="ROW_DESC">{{ t("Pick the fields to copy; the model's ID and API won't change") }}</span>
                </span>
              </div>
              <label
                v-for="change in refChanges"
                :key="change.field"
                
                :class="[ROW_PICK, { off: change.same }]"
              >
                <input
                  type="checkbox"
                  :checked="!change.same && refChecked.has(change.field)"
                  :disabled="change.same"
                  @change="toggleReferenceField(change.field)"
                />
                <span :class="rowMain()">
                  <span :class="rowTitle()">{{ FIELD_LABEL[change.field]() }}</span>
                  <span v-if="change.same" :class="ROW_DESC">{{ referenceText(refPicked, change.field) }} · {{ t("already the same") }}</span>
                  <span v-else :class="ROW_DESC">
                    {{ currentText(model, change.field) }} → <span class="font-medium text-fg">{{ referenceText(refPicked, change.field) }}</span>
                  </span>
                  <span v-if="change.field === 'cost' && refPicked.costTiers" :class="ROW_DESC">
                    {{ t("It also prices by input length; those tiers aren't copied") }}
                  </span>
                </span>
              </label>
              <div class="min-h-13 gap-2 px-3 py-2" :class="row({ size: 'none' })">
                <span class="spacer" />
                <Button variant="ghost" size="sm" @click="closeReference">{{ t("Cancel") }}</Button>
                <Button variant="primary" size="sm" :disabled="refToApply.length === 0" @click="applyPicked">
                  {{ t("Copy {n} field|Copy {n} fields", { n: refToApply.length }) }}
                </Button>
              </div>
            </template>
          </div>
          <div :class="FIELD">
            <label :for="`pv-model-${model.key}`">ID</label>
            <Input :id="`pv-model-${model.key}`" v-model="model.id" mono spellcheck="false" autocomplete="off" />
          </div>
          <div :class="FIELD">
            <label :for="`pv-mname-${model.key}`">{{ t("Name") }}</label>
            <Input :id="`pv-mname-${model.key}`" v-model="model.name" autocomplete="off" :placeholder="model.id" />
          </div>
          <div :class="FIELD">
            <label :for="`pv-ctx-${model.key}`">{{ t("Context window") }}</label>
            <Input :id="`pv-ctx-${model.key}`" v-model="model.contextWindow" mono placeholder="128k" />
          </div>
          <div :class="FIELD">
            <label :for="`pv-max-${model.key}`">{{ t("Max output") }}</label>
            <Input :id="`pv-max-${model.key}`" v-model="model.maxTokens" mono placeholder="16k" />
          </div>
          <div class="col-span-full flex flex-row gap-6 [&>label]:text-xs [&>label]:font-medium [&>label]:text-fg-muted">
            <label :class="TOGGLE">
              <Switch :model-value="model.reasoning" @update:model-value="model.reasoning = !model.reasoning" />
              <span>{{ t("Reasoning") }}</span>
            </label>
            <label :class="TOGGLE">
              <Switch :model-value="model.image" @update:model-value="model.image = !model.image" />
              <span>{{ t("Image input") }}</span>
            </label>
          </div>
          <fieldset class="col-span-full m-0 grid min-w-0 grid-cols-4 gap-1.5 border-0 p-0 @max-[44.2857em]/vp:grid-cols-2 [&>legend]:mb-1.5 [&>legend]:p-0 [&>legend]:text-xs [&>legend]:font-medium [&>legend]:text-fg-muted">
            <legend>{{ t("Price (USD per million tokens)") }}</legend>
            <Input v-model="model.cost.input" mono inputmode="decimal" :placeholder="t('Input')" :aria-label="t('Input price')" />
            <Input v-model="model.cost.output" mono inputmode="decimal" :placeholder="t('Output')" :aria-label="t('Output price')" />
            <Input v-model="model.cost.cacheRead" mono inputmode="decimal" :placeholder="t('Cache read')" :aria-label="t('Cache read price')" />
            <Input v-model="model.cost.cacheWrite" mono inputmode="decimal" :placeholder="t('Cache write')" :aria-label="t('Cache write price')" />
          </fieldset>
        </div>
      </div>
    </div>

    <details :class="DISCLOSURE">
      <summary>{{ t("Advanced") }}</summary>
      <div class="mt-2" :class="rows()">
        <div :class="formRow()">
          <label for="pv-name">{{ t("Display name") }}</label>
          <div :class="FIELD_CTRL">
            <Input id="pv-name" v-model="draft.name" autocomplete="off" :placeholder="providerId" />
            <span :class="FIELD_NOTE">{{ t("Only for display; the ID shows when it is empty") }}</span>
          </div>
        </div>
        <div :class="formRow({ top: true })">
          <span :class="FORM_LABEL">{{ t("Headers") }}</span>
          <KeyValueRows :rows="draft.headers" :label="t('Headers')" key-placeholder="X-Header" value-placeholder="$ENV_NAME" />
        </div>
        <div :class="formRow()">
          <span :class="FORM_LABEL">authHeader</span>
          <label :class="TOGGLE">
            <Switch :model-value="draft.authHeader" @update:model-value="draft.authHeader = !draft.authHeader" />
            <span>{{ t("Also send the key as a Bearer token") }}</span>
          </label>
        </div>
        <div :class="formRow()">
          <label for="pv-apikey">apiKey</label>
          <div :class="FIELD_CTRL">
            <Input id="pv-apikey" v-model="draft.apiKey" mono :type="draft.apiKey === '' || isEnvReference(draft.apiKey) ? 'text' : 'password'" spellcheck="false" autocomplete="off" placeholder="$ENV_NAME" />
            <span :class="FIELD_NOTE">{{ t("Written to models.json and may reference environment variables; a key set above takes precedence") }}</span>
          </div>
        </div>
      </div>
    </details>

    <footer :class="FORM_FOOT">
      <span v-if="formError || saving.error.value" class="error" role="alert">{{ formError ?? saving.error.value }}</span>
      <span class="spacer" />
      <Button variant="ghost" size="sm" :disabled="!dirty && !isNew" @click="discard">
        {{ isNew ? t("Cancel") : t("Discard changes") }}
      </Button>
      <Button type="submit" variant="primary" size="sm" :disabled="(!dirty && !isNew) || saving.busy.value">
        {{ isNew ? t("Add") : t("Save") }}
      </Button>
    </footer>
  </form>
</template>
