<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { CapabilitiesView } from "@shared/api/contract.ts";
import { computed, nextTick, reactive, ref, watch } from "vue";
import { configIssueText, errorText } from "../errors.ts";
import { t } from "../i18n.ts";
import {
  fromMcpDraft,
  isServerName,
  MCP_EXPOSURES,
  type McpDraft,
  type McpDraftError,
  type McpExposure,
  parsePastedServer,
  toMcpDraft,
} from "../mcp-draft.ts";
import { formatRoute, NEW_ITEM } from "../router.ts";
import { vSeg } from "../dom.ts";
import { useSubmit } from "../submit.ts";
import { showToast } from "../toasts.ts";
import Icon from "./Icon.vue";
import KeyValueRows from "./KeyValueRows.vue";
import Skeleton from "./Skeleton.vue";

const props = defineProps<{
  client: Client;
  /** The server's name, or `NEW_ITEM` to add one. */
  name: string;
  capabilities: CapabilitiesView;
}>();

const emit = defineEmits<{ changed: [view: CapabilitiesView] }>();

const LIST = formatRoute({ name: "settings", section: "mcp" });

const EXPOSURE_LABEL: Record<McpExposure, { label: string; detail: string }> = {
  deferred: { label: t("On demand"), detail: t("Found on demand with tool_search; best when there are many tools") },
  direct: { label: t("Direct"), detail: t("Offered up front like any other tool; best when there are only a few tools") },
  codemode: { label: t("Code mode"), detail: t("Called only from codemode scripts; best for batched or combined calls") },
  hidden: { label: t("Hidden"), detail: t("Stays connected but offers no tools") },
};

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
    location.hash = formatRoute({ name: "settings", section: "mcp", item: name });
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
</script>

<template>
  <header class="set-head">
    <a class="btn ghost sm icon" :href="LIST" :aria-label="t('Back to MCP servers')">
      <Icon name="chevL" size="sm" />
    </a>
    <h2 class="ellipsis" :class="{ mono: !isNew }">{{ isNew ? t("Add MCP server") : name }}</h2>
    <template v-if="!isNew && original">
      <template v-if="confirmRemove">
        <button type="button" class="btn sm danger" :disabled="removing.busy.value" @click="remove">
          {{ t("Confirm delete") }}
        </button>
        <button type="button" class="btn ghost sm" @click="confirmRemove = false">{{ t("Cancel") }}</button>
      </template>
      <button
        v-else
        type="button"
        class="btn ghost sm danger"
        :title="roles > 0 ? t('Also turns it off for the roles that enable it') : undefined"
        @click="confirmRemove = true"
      >
        <Icon name="x" size="xs" />
        <span>{{ t("Delete") }}</span>
      </button>
    </template>
    <button v-if="isNew && !pasting" type="button" class="btn ghost sm" @click="pasting = true">
      <Icon name="copy" size="xs" />
      <span>{{ t("Paste JSON") }}</span>
    </button>
  </header>

  <p v-if="loadError" class="error hint">{{ loadError }}</p>
  <p v-else-if="removing.error.value" class="error hint">{{ removing.error.value }}</p>
  <Skeleton v-if="entries === undefined && !loadError" />
  <div v-else-if="missing" class="empty">
    <h3>{{ t("No server named {name}", { name }) }}</h3>
    <a class="btn sm" :href="LIST">{{ t("Back to MCP servers") }}</a>
  </div>
  <form v-else-if="entries" class="pv-form" @submit.prevent="save">
    <div v-if="pasting" class="paste">
      <textarea
        v-model="pasted"
        class="input mono"
        rows="6"
        spellcheck="false"
        :aria-label="t('Paste JSON')"
        placeholder='{ "mcpServers": { "github": { "command": "github-mcp-server", "args": ["stdio"] } } }'
      />
      <div class="f-inline">
        <span class="spacer" />
        <button type="button" class="btn ghost sm" @click="pasting = false">{{ t("Cancel") }}</button>
        <button type="button" class="btn sm" :disabled="pasted.trim() === ''" @click="applyPaste">{{ t("Fill in") }}</button>
      </div>
    </div>

    <div v-if="status || problems.length > 0" class="rows">
      <div v-if="status" class="row">
        <div class="r-main">
          <span class="r-t">
            <span class="dot" :class="STATE_LABEL[status.state]?.dot" />
            <span>{{ STATE_LABEL[status.state]?.label }}</span>
          </span>
          <span class="r-d">
            {{ t("{n} tool|{n} tools", { n: status.tools }) }}
            <template v-if="roles > 0"> · {{ t("Enabled for {n} role|Enabled for {n} roles", { n: roles }) }}</template>
          </span>
          <span v-if="status.error" class="err">{{ configIssueText(status.error) }}</span>
        </div>
      </div>
      <div v-for="(problem, index) in problems" :key="index" class="row">
        <div class="r-main">
          <span class="r-t"><span class="dot bad" /><span>{{ t("Misconfigured, not connected") }}</span></span>
          <span class="err">{{ configIssueText(problem) }}</span>
        </div>
      </div>
    </div>

    <div class="section-t"><h3>{{ t("Connection") }}</h3></div>
    <div class="rows">
      <div v-if="isNew" class="f-row">
        <label for="mcp-name">{{ t("Name") }}</label>
        <div class="f-ctrl">
          <input id="mcp-name" v-model="newName" class="input mono" spellcheck="false" autocomplete="off" placeholder="github" />
        </div>
      </div>
      <div class="f-row">
        <span class="f-label">{{ t("Transport") }}</span>
        <div v-seg class="seg sm" role="group" :aria-label="t('Transport')">
          <button type="button" :class="{ on: draft.transport === 'stdio' }" :aria-pressed="draft.transport === 'stdio'" @click="draft.transport = 'stdio'">
            {{ t("Local command") }}
          </button>
          <button type="button" :class="{ on: draft.transport === 'http' }" :aria-pressed="draft.transport === 'http'" @click="draft.transport = 'http'">
            HTTP
          </button>
        </div>
      </div>
      <template v-if="draft.transport === 'stdio'">
        <div class="f-row">
          <label for="mcp-command">{{ t("Command") }}</label>
          <div class="f-ctrl">
            <input id="mcp-command" v-model="draft.command" class="input mono" spellcheck="false" autocomplete="off" placeholder="npx" />
          </div>
        </div>
        <div class="f-row top">
          <label for="mcp-args">{{ t("Arguments") }}</label>
          <div class="f-ctrl">
            <textarea
              id="mcp-args"
              v-model="draft.args"
              class="input mono"
              rows="3"
              spellcheck="false"
              :placeholder="'-y\n@modelcontextprotocol/server-filesystem\n/home/me/papers'"
            />
            <span class="f-note">{{ t("One argument per line") }}</span>
          </div>
        </div>
        <div class="f-row">
          <label for="mcp-cwd">{{ t("Working directory") }}</label>
          <div class="f-ctrl">
            <input id="mcp-cwd" v-model="draft.cwd" class="input mono" spellcheck="false" autocomplete="off" />
          </div>
        </div>
        <div class="f-row top">
          <span class="f-label">{{ t("Environment variables") }}</span>
          <KeyValueRows :rows="draft.env" :label="t('Environment variables')" key-placeholder="GITHUB_TOKEN" value-placeholder="${GITHUB_TOKEN}" />
        </div>
      </template>
      <template v-else>
        <div class="f-row">
          <label for="mcp-url">URL</label>
          <div class="f-ctrl">
            <input id="mcp-url" v-model="draft.url" class="input mono" spellcheck="false" autocomplete="off" placeholder="https://example.com/mcp" />
          </div>
        </div>
        <div class="f-row top">
          <span class="f-label">{{ t("Headers") }}</span>
          <KeyValueRows :rows="draft.headers" :label="t('Headers')" key-placeholder="Authorization" value-placeholder="Bearer ${TOKEN}" />
        </div>
      </template>
    </div>

    <div class="section-t"><h3>{{ t("Tools") }}</h3></div>
    <div class="rows">
      <div class="f-row">
        <span class="f-label">{{ t("Enabled") }}</span>
        <label class="toggle">
          <button
            type="button"
            class="switch"
            :class="{ on: draft.enabled }"
            :aria-pressed="draft.enabled"
            :aria-label="t('Enabled')"
            @click="draft.enabled = !draft.enabled"
          />
        </label>
      </div>
      <div class="f-row top">
        <span class="f-label">{{ t("Exposure") }}</span>
        <div class="f-ctrl">
          <div v-seg class="seg sm" role="group" :aria-label="t('Exposure')">
            <button
              v-for="exposure in MCP_EXPOSURES"
              :key="exposure"
              type="button"
              :class="{ on: draft.exposure === exposure }"
              :aria-pressed="draft.exposure === exposure"
              @click="draft.exposure = exposure"
            >
              {{ EXPOSURE_LABEL[exposure].label }}
            </button>
          </div>
          <span class="f-note">{{ EXPOSURE_LABEL[draft.exposure].detail }}</span>
        </div>
      </div>
      <div class="f-row">
        <label for="mcp-desc">{{ t("Description") }}</label>
        <div class="f-ctrl">
          <input id="mcp-desc" v-model="draft.description" class="input" autocomplete="off" :placeholder="t('What it offers, in a sentence')" />
        </div>
      </div>
      <div class="f-row">
        <label for="mcp-timeout">{{ t("Timeout (seconds)") }}</label>
        <div class="f-ctrl">
          <input id="mcp-timeout" v-model="draft.timeout" class="input mono short" inputmode="decimal" autocomplete="off" />
        </div>
      </div>
    </div>

    <footer class="f-foot">
      <span v-if="formError || saving.error.value" class="error" role="alert">{{ formError ?? saving.error.value }}</span>
      <span class="spacer" />
      <button type="button" class="btn ghost sm" :disabled="!dirty && !isNew" @click="discard">
        {{ isNew ? t("Cancel") : t("Discard changes") }}
      </button>
      <button type="submit" class="btn sm primary" :disabled="(!dirty && !isNew) || saving.busy.value">
        {{ isNew ? t("Add") : t("Save") }}
      </button>
    </footer>
  </form>
</template>
