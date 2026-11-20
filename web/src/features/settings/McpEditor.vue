<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { CapabilitiesView } from "@shared/protocol/contract.ts";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { configIssueText, errorText } from "../../lib/errors.ts";
import { t } from "../../lib/i18n.ts";
import { EXPOSURE_LABEL } from "../../lib/labels.ts";
import {
  fromMcpDraft,
  isServerName,
  MCP_EXPOSURES,
  type McpDraft,
  type McpDraftError,
  parsePastedServer,
  toMcpDraft,
} from "../../lib/mcp-draft.ts";
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
import type { SegmentedOption } from "../../ui/Segmented.vue";
import Segmented from "../../ui/Segmented.vue";
import SectionHeader from "../../ui/SectionHeader.vue";
import { ROW_DESC, row, rowMain, rowTitle, rows } from "../../ui/rows.ts";
import { FIELD_CTRL, FIELD_INLINE, FIELD_NOTE, FORM, FORM_FOOT, FORM_LABEL, SECTION_T, TOGGLE, formRow } from "../../ui/form.ts";
import { EMPTY } from "../../ui/surface.ts";

const props = defineProps<{
  client: Client;
  /** The server's name, or `NEW_ITEM` to add one. */
  name: string;
  capabilities: CapabilitiesView;
}>();

const emit = defineEmits<{ changed: [view: CapabilitiesView] }>();

const LIST = formatRoute({ name: "control", section: "mcp" });

const STATE_LABEL: Record<string, { dot: string; label: string }> = {
  connected: { dot: "ok", label: t("Connected") },
  connecting: { dot: "run", label: t("Connecting") },
  failed: { dot: "bad", label: t("Failed") },
  disabled: { dot: "", label: t("Disabled") },
};

const entries = ref<Record<string, Record<string, unknown>>>();
const loadError = ref<string>();
const draft = reactive<McpDraft>(toMcpDraft(undefined));
const snapshot = ref("");
const newName = ref("");
const formError = ref<string>();
const confirmRemove = ref(false);
const pasting = ref(false);
const pasted = ref("");
const saving = useSubmit();
const removing = useSubmit();

const isNew = computed(() => props.name === NEW_ITEM);
const serverName = computed(() => (isNew.value ? newName.value.trim() : props.name));
const original = computed(() => (isNew.value ? undefined : entries.value?.[props.name]));
const status = computed(() => props.capabilities.mcp.find((m) => m.name === props.name));
const problems = computed(() =>
  props.capabilities.problems.filter((p) => p.file === "mcp.json" && p.entry === props.name),
);
const missing = computed(() => !isNew.value && entries.value !== undefined && !original.value);
const dirty = computed(
  () => JSON.stringify(draft) !== snapshot.value || (isNew.value && newName.value.trim() !== ""),
);
const roles = computed(() =>
  props.capabilities.roles.filter((r) => r.enabled.includes(`mcp.${props.name}`)).length,
);

function reset(entry: Record<string, unknown> | undefined): void {
  Object.assign(draft, toMcpDraft(entry));
  snapshot.value = JSON.stringify(draft);
  formError.value = undefined;
  confirmRemove.value = false;
  saving.error.value = undefined;
  removing.error.value = undefined;
}

async function loadEntries(): Promise<void> {
  loadError.value = undefined;
  try {
    entries.value = (await props.client.call("GET /api/mcp/config")).servers;
  } catch (error) {
    loadError.value = errorText(error);
  }
}

watch(
  () => props.name,
  async () => {
    newName.value = "";
    pasting.value = false;
    pasted.value = "";
    await loadEntries();
    reset(original.value);
    if (isNew.value) {
      await nextTick();
      document.querySelector<HTMLInputElement>("#mcp-name")?.focus();
    }
  },
  { immediate: true },
);

function applyPaste(): void {
  const found = parsePastedServer(pasted.value);
  if (found === undefined) {
    formError.value = t("No server config found: paste JSON with a command or url");
    return;
  }
  Object.assign(draft, toMcpDraft(found.config));
  if (found.name !== undefined && newName.value.trim() === "") newName.value = found.name;
  pasting.value = false;
  pasted.value = "";
  formError.value = undefined;
}

function draftErrorText(error: McpDraftError): string {
  if (error.code === "timeout") return t("Timeout must be a positive number of seconds");
  return error.field === "command" ? t("Enter a command") : t("Enter a URL");
}

async function save(): Promise<void> {
  formError.value = undefined;
  const name = serverName.value;
  if (isNew.value) {
    if (!isServerName(name)) {
      formError.value = t("Names may contain only letters, digits, _ and -");
      return;
    }
    if (entries.value?.[name]) {
      formError.value = t("There is already a server named {name}", { name });
      return;
    }
  }
  const result = fromMcpDraft(draft, original.value);
  if ("error" in result) {
    formError.value = draftErrorText(result.error);
    return;
  }
  const ok = await saving.run(async () => {
    const view = await props.client.call("PUT /api/mcp/servers/:server", { server: name }, { config: result.config });
    emit("changed", view);
  });
  if (!ok) return;
  showToast(t("Saved {name}", { name }));
  if (isNew.value) {
    location.hash = formatRoute({ name: "control", section: "mcp", item: name });
    return;
  }
  await loadEntries();
  reset(original.value);
}

function discard(): void {
  if (isNew.value) location.hash = LIST;
  else reset(original.value);
}

async function remove(): Promise<void> {
  const ok = await removing.run(async () => {
    const view = await props.client.call("DELETE /api/mcp/servers/:server", { server: props.name });
    emit("changed", view);
  });
  if (!ok) return;
  showToast(t("Deleted {name}", { name: props.name }));
  location.hash = LIST;
}

const TRANSPORT_OPTIONS: SegmentedOption<"stdio" | "http">[] = [
  { value: "stdio", label: t("Local command") },
  { value: "http", label: "HTTP" },
];
</script>

<template>
  <SectionHeader :title="isNew ? t('Add MCP server') : name" :mono="!isNew">
    <template #leading>
      <Button variant="ghost" size="sm" icon :href="LIST" :aria-label="t('Back to MCP servers')">
        <Icon name="chevL" size="sm" />
      </Button>
    </template>
    <template v-if="!isNew && original">
      <template v-if="confirmRemove">
        <Button variant="danger" size="sm" :disabled="removing.busy.value" @click="remove">
          {{ t("Confirm delete") }}
        </Button>
        <Button variant="ghost" size="sm" @click="confirmRemove = false">{{ t("Cancel") }}</Button>
      </template>
      <Button v-else variant="ghost-danger" size="sm" :title="roles > 0 ? t('Also turns it off for the roles that enable it') : undefined" @click="confirmRemove = true">
        <Icon name="x" size="xs" />
        <span>{{ t("Delete") }}</span>
      </Button>
    </template>
    <Button v-if="isNew && !pasting" variant="ghost" size="sm" @click="pasting = true">
      <Icon name="copy" size="xs" />
      <span>{{ t("Paste JSON") }}</span>
    </Button>
  </SectionHeader>

  <p v-if="loadError" class="error hint">{{ loadError }}</p>
  <p v-else-if="removing.error.value" class="error hint">{{ removing.error.value }}</p>
  <Skeleton v-if="entries === undefined && !loadError" />
  <div v-else-if="missing" :class="EMPTY">
    <h3>{{ t("No server named {name}", { name }) }}</h3>
    <Button size="sm" :href="LIST">{{ t("Back to MCP servers") }}</Button>
  </div>
  <form v-else-if="entries" :class="FORM" @submit.prevent="save">
    <div v-if="pasting" class="flex flex-col gap-2">
      <textarea v-model="pasted" :class="fieldClass({ mono: true, multiline: true })" rows="6" spellcheck="false" :aria-label="t('Paste JSON')" placeholder='{ "mcpServers": { "github": { "command": "github-mcp-server", "args": ["stdio"] } } }' />
      <div :class="FIELD_INLINE">
        <span class="spacer" />
        <Button variant="ghost" size="sm" @click="pasting = false">{{ t("Cancel") }}</Button>
        <Button size="sm" :disabled="pasted.trim() === ''" @click="applyPaste">{{ t("Fill in") }}</Button>
      </div>
    </div>

    <div v-if="status || problems.length > 0" :class="rows()">
      <div v-if="status" :class="row()">
        <div :class="rowMain()">
          <span :class="rowTitle()">
            <span class="dot" :class="STATE_LABEL[status.state]?.dot" />
            <span>{{ STATE_LABEL[status.state]?.label }}</span>
          </span>
          <span :class="ROW_DESC">
            {{ t("{n} tool|{n} tools", { n: status.tools }) }}
            <template v-if="roles > 0"> · {{ t("Enabled for {n} role|Enabled for {n} roles", { n: roles }) }}</template>
          </span>
          <span v-if="status.error" class="err">{{ configIssueText(status.error) }}</span>
        </div>
      </div>
      <div v-for="(problem, index) in problems" :key="index" :class="row()">
        <div :class="rowMain()">
          <span :class="rowTitle()"><span class="dot bad" /><span>{{ t("Misconfigured, not connected") }}</span></span>
          <span class="err">{{ configIssueText(problem) }}</span>
        </div>
      </div>
    </div>

    <div :class="SECTION_T"><h3>{{ t("Connection") }}</h3></div>
    <div :class="rows()">
      <div :class="formRow()" v-if="isNew">
        <label for="mcp-name">{{ t("Name") }}</label>
        <div :class="FIELD_CTRL">
          <Input id="mcp-name" v-model="newName" mono spellcheck="false" autocomplete="off" placeholder="github" />
        </div>
      </div>
      <div :class="formRow()">
        <span :class="FORM_LABEL">{{ t("Transport") }}</span>
        <Segmented v-model="draft.transport" :options="TRANSPORT_OPTIONS" :label="t('Transport')" />
      </div>
      <template v-if="draft.transport === 'stdio'">
        <div :class="formRow()">
          <label for="mcp-command">{{ t("Command") }}</label>
          <div :class="FIELD_CTRL">
            <Input id="mcp-command" v-model="draft.command" mono spellcheck="false" autocomplete="off" placeholder="npx" />
          </div>
        </div>
        <div :class="formRow({ top: true })">
          <label for="mcp-args">{{ t("Arguments") }}</label>
          <div :class="FIELD_CTRL">
            <textarea id="mcp-args" v-model="draft.args" :class="fieldClass({ mono: true, multiline: true })" rows="3" spellcheck="false" :placeholder="'-y\n@modelcontextprotocol/server-filesystem\n/home/me/papers'" />
            <span :class="FIELD_NOTE">{{ t("One argument per line") }}</span>
          </div>
        </div>
        <div :class="formRow()">
          <label for="mcp-cwd">{{ t("Working directory") }}</label>
          <div :class="FIELD_CTRL">
            <Input id="mcp-cwd" v-model="draft.cwd" mono spellcheck="false" autocomplete="off" />
          </div>
        </div>
        <div :class="formRow({ top: true })">
          <span :class="FORM_LABEL">{{ t("Environment variables") }}</span>
          <KeyValueRows :rows="draft.env" :label="t('Environment variables')" key-placeholder="GITHUB_TOKEN" value-placeholder="${GITHUB_TOKEN}" />
        </div>
      </template>
      <template v-else>
        <div :class="formRow()">
          <label for="mcp-url">URL</label>
          <div :class="FIELD_CTRL">
            <Input id="mcp-url" v-model="draft.url" mono spellcheck="false" autocomplete="off" placeholder="https://example.com/mcp" />
          </div>
        </div>
        <div :class="formRow({ top: true })">
          <span :class="FORM_LABEL">{{ t("Headers") }}</span>
          <KeyValueRows :rows="draft.headers" :label="t('Headers')" key-placeholder="Authorization" value-placeholder="Bearer ${TOKEN}" />
        </div>
      </template>
    </div>

    <div :class="SECTION_T"><h3>{{ t("Tools") }}</h3></div>
    <div :class="rows()">
      <div :class="formRow()">
        <span :class="FORM_LABEL">{{ t("Enabled") }}</span>
        <label :class="TOGGLE">
          <Switch :model-value="draft.enabled" :aria-label="t('Enabled')" @update:model-value="draft.enabled = !draft.enabled" />
        </label>
      </div>
      <div :class="formRow({ top: true })">
        <span :class="FORM_LABEL">{{ t("Exposure") }}</span>
        <div :class="FIELD_CTRL">
          <Segmented v-model="draft.exposure" :options="MCP_EXPOSURES.map((value) => ({ value, label: EXPOSURE_LABEL[value].label }))" :label="t('Exposure')" />
          <span :class="FIELD_NOTE">{{ EXPOSURE_LABEL[draft.exposure].detail }}</span>
        </div>
      </div>
      <div :class="formRow()">
        <label for="mcp-desc">{{ t("Description") }}</label>
        <div :class="FIELD_CTRL">
          <Input id="mcp-desc" v-model="draft.description" autocomplete="off" :placeholder="t('What it offers, in a sentence')" />
        </div>
      </div>
      <div :class="formRow()">
        <label for="mcp-timeout">{{ t("Timeout (seconds)") }}</label>
        <div :class="FIELD_CTRL">
          <Input id="mcp-timeout" v-model="draft.timeout" mono inline class="w-24" inputmode="decimal" autocomplete="off" />
        </div>
      </div>
    </div>

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
