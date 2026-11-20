<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type {
  CapabilitiesView,
  EngineStatus,
  McpServerView,
  ModelSpecView,
} from "@shared/protocol/contract.ts";
import {
  type ModelChoice,
  type ModelDefaults,
  pickModel,
  type RoleName,
  type ThinkingLevel,
} from "@shared/domain/index.ts";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { configIssueText, configProblemText, errorText } from "../../lib/errors.ts";
import { ROLE_LABEL } from "../../lib/labels.ts";
import { LOCALE_NAME, LOCALES, locale, setLocale, t } from "../../lib/i18n.ts";
import { levelsOf, switchModel, levelLabel } from "../../lib/model-choice.ts";
import { useModelsView } from "../../composables/models-view.ts";
import { formatRoute, NEW_ITEM, type SettingsSection } from "../../lib/router.ts";
import type { StreamState } from "../../lib/stream.ts";
import { useSubmit } from "../../composables/submit.ts";
import { type ThemePreference, useTheme, useTypography } from "../../composables/theme.ts";
import { showToast } from "../../composables/toasts.ts";
import { readTextSize, TEXT_SIZE } from "../../lib/typography.ts";
import { notifyEnabled, notifySupported, setNotifyEnabled } from "../../composables/use-notifications.ts";
import Icon from "../../ui/Icon.vue";
import LevelMenu from "./LevelMenu.vue";
import MarkdownText from "../markdown/MarkdownText.vue";
import McpEditor from "./McpEditor.vue";
import ModelMenu from "./ModelMenu.vue";
import ProviderEditor from "./ProviderEditor.vue";
import RoleSettings from "./RoleSettings.vue";
import Skeleton from "../../ui/Skeleton.vue";
import Button from "../../ui/Button.vue";
import Input from "../../ui/Input.vue";
import Switch from "../../ui/Switch.vue";
import Segmented from "../../ui/Segmented.vue";
import SectionHeader from "../../ui/SectionHeader.vue";
import { badge, banner, CODELINE, PANEL, TABLE } from "../../ui/surface.ts";
import { ROW_DESC, ROW_LINK, row, rowMain, rowTitle, rows } from "../../ui/rows.ts";
import { SECTION_T } from "../../ui/form.ts";

const props = defineProps<{
  client: Client;
  section: SettingsSection;
  /** The provider or MCP server open on its own page, or `NEW_ITEM` to add one. */
  item?: string | undefined;
  status: EngineStatus | undefined;
  streamState: StreamState;
  refreshStatus: () => Promise<void>;
}>();

const { preference: themePref, setTheme } = useTheme();
const { size: textSize, font, setTextSize, setFont } = useTypography();

// ——— Desktop notifications: the switch persists `eevee.notify`; the browser keeps the permission ———
const notifyPermission = ref<NotificationPermission | "unsupported">(
  notifySupported() ? Notification.permission : "unsupported",
);
const notifyOn = ref(notifyEnabled());

const notifyHint = computed(() => {
  if (notifyPermission.value === "unsupported") {
    return t("This browser cannot show desktop notifications");
  }
  if (notifyPermission.value === "denied") {
    return t("Notifications are blocked in the browser settings");
  }
  return t("New questions, blocked tickets and Router failures");
});

async function toggleNotify(): Promise<void> {
  if (notifyOn.value) {
    setNotifyEnabled(false);
    notifyOn.value = false;
    return;
  }
  if (notifyPermission.value === "default") {
    notifyPermission.value = await Notification.requestPermission();
  }
  if (notifyPermission.value !== "granted") return;
  setNotifyEnabled(true);
  notifyOn.value = true;
}

function onSizeInput(event: Event): void {
  const size = readTextSize((event.target as HTMLInputElement).value);
  if (size !== undefined) setTextSize(size);
}

/** Leaving the field with a size it does not take puts back the one in use. */
function onSizeBlur(event: Event): void {
  (event.target as HTMLInputElement).value = String(textSize.value);
}

const {
  view: modelsView,
  error: modelsError,
  loading: loadingModels,
  load: loadModels,
} = useModelsView(props.client);
/** The open menu of a model row: its model list or its thinking levels. */
const pop = ref<{ role: "default" | RoleName; menu: "model" | "level" }>();
const showAllProviders = ref(false);
const savingModel = useSubmit();

const capabilities = ref<CapabilitiesView>();
const capError = ref<string>();
const loadingCap = ref(false);
const savingRole = useSubmit();
const reloadingMcp = useSubmit();

const MODEL_ROLES: { key: "default" | RoleName; label: string }[] = [
  { key: "default", label: t("Global default") },
  { key: "router", label: "Router" },
  { key: "worker", label: "Worker" },
  { key: "dreamer", label: "Dreamer" },
];

const THEME_OPTIONS: { key: ThemePreference; label: string }[] = [
  { key: "system", label: t("System") },
  { key: "light", label: t("Light") },
  { key: "dark", label: t("Dark") },
];

const RESTART = "eevee stop && eevee start";

const NEW_PROVIDER = formatRoute({ name: "control", section: "models", item: NEW_ITEM });
const NEW_SERVER = formatRoute({ name: "control", section: "mcp", item: NEW_ITEM });
const providerHref = (id: string) => formatRoute({ name: "control", section: "models", item: id });
const serverHref = (name: string) => formatRoute({ name: "control", section: "mcp", item: name });

const MCP_STATE_LABEL: Record<McpServerView["state"], { dot: string; label: string }> = {
  connected: { dot: "ok", label: t("Connected") },
  connecting: { dot: "run", label: t("Connecting") },
  failed: { dot: "bad", label: t("Failed") },
  disabled: { dot: "", label: t("Disabled") },
};

async function loadCapabilities(quiet = false): Promise<void> {
  loadingCap.value = !quiet;
  capError.value = undefined;
  try {
    capabilities.value = await props.client.call("GET /api/capabilities");
  } catch (err) {
    capError.value = errorText(err);
  } finally {
    loadingCap.value = false;
  }
}

/** mcp.json's entries, which the server list switches on and off. */
const mcpEntries = ref<Record<string, Record<string, unknown>>>();
const togglingServer = useSubmit();

watch(
  () => props.section,
  (sec) => {
    pop.value = undefined;
    if (sec === "models" && modelsView.value === undefined) void loadModels();
    if (!capabilities.value) void loadCapabilities();
    if (sec === "mcp") void loadMcpEntries();
  },
  { immediate: true },
);

async function loadMcpEntries(): Promise<void> {
  try {
    mcpEntries.value = (await props.client.call("GET /api/mcp/config")).servers;
  } catch {
    mcpEntries.value = undefined;
  }
}

async function toggleServer(name: string): Promise<void> {
  const entry = mcpEntries.value?.[name];
  if (entry === undefined) return;
  const { enabled, ...rest } = entry;
  const config = enabled === false ? rest : { ...rest, enabled: false };
  const ok = await togglingServer.run(async () => {
    applyCapabilities(await props.client.call("PUT /api/mcp/servers/:server", { server: name }, { config }));
  });
  if (ok) await loadMcpEntries();
}

function applyCapabilities(view: CapabilitiesView): void {
  capabilities.value = view;
}

// Servers connect in the background; while one is still connecting, look again shortly.
let polling: ReturnType<typeof setTimeout> | undefined;
watch(capabilities, (view) => {
  clearTimeout(polling);
  if (view?.mcp.some((m) => m.state === "connecting")) {
    polling = setTimeout(() => void loadCapabilities(true), 1000);
  }
});
onUnmounted(() => clearTimeout(polling));

/** A problem's entry in mcp.json, which can be opened and fixed. */
function problemServer(problem: { file: string; entry?: string }): string | undefined {
  return problem.file === "mcp.json" ? problem.entry : undefined;
}

function onWindowClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target?.closest(".model-row-ctrl")) {
    pop.value = undefined;
  }
}

onMounted(() => window.addEventListener("mousedown", onWindowClick));
onUnmounted(() => window.removeEventListener("mousedown", onWindowClick));

const availableModels = computed(() => modelsView.value?.available ?? []);
const configuredProviders = computed(() =>
  (modelsView.value?.providers ?? []).filter((p) => p.configured),
);
const unconfiguredProviders = computed(() =>
  (modelsView.value?.providers ?? []).filter((p) => !p.configured),
);
const visibleProviders = computed(() =>
  showAllProviders.value || configuredProviders.value.length === 0
    ? (modelsView.value?.providers ?? [])
    : configuredProviders.value,
);

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function formatCacheDuration(seconds: number): string {
  return seconds >= 3600
    ? t("{n} h", { n: +(seconds / 3600).toFixed(1) })
    : t("{n} min", { n: Math.round(seconds / 60) });
}

function formatModelMeta(model: ModelSpecView): string {
  const parts: string[] = [];
  if (model.cost.input || model.cost.output) {
    parts.push(
      t("In {price}/M", { price: `$${model.cost.input}` }),
      t("Out {price}/M", { price: `$${model.cost.output}` }),
    );
  }
  if (model.cost.cacheRead) parts.push(t("Cache read {price}/M", { price: `$${model.cost.cacheRead}` }));
  if (model.cacheShortSeconds) {
    parts.push(t("Cache {tokens}", { tokens: formatCacheDuration(model.cacheShortSeconds) }));
  }
  if (model.reasoning) parts.push(t("Reasoning"));
  return parts.join(" · ") || "—";
}

function togglePop(role: "default" | RoleName, menu: "model" | "level"): void {
  const same = pop.value?.role === role && pop.value.menu === menu;
  pop.value = same ? undefined : { role, menu };
}

/** The model a row's role runs on: its own default, else the one it falls back to. */
function effectiveModel(roleKey: "default" | RoleName): ModelChoice | undefined {
  const defaults = modelsView.value?.defaults;
  return roleKey === "default" ? defaults?.default : pickModel(roleKey, defaults);
}

function rowLevels(roleKey: "default" | RoleName): readonly ThinkingLevel[] {
  return levelsOf(availableModels.value, effectiveModel(roleKey));
}

function rowLevel(roleKey: "default" | RoleName): ThinkingLevel {
  return effectiveModel(roleKey)?.thinkingLevel ?? "off";
}

function modelLabel(roleKey: keyof ModelDefaults): { text: string; inherited: boolean } {
  const defaults = modelsView.value?.defaults;
  const own = defaults?.[roleKey];
  if (own) return { text: `${own.provider}/${own.modelId}`, inherited: false };
  const effective = roleKey === "router" ? modelsView.value?.routerModel : defaults?.default;
  if (roleKey !== "default" && effective) {
    return { text: t("Default · {model}", { model: `${effective.provider}/${effective.modelId}` }), inherited: true };
  }
  return { text: t("Not set"), inherited: true };
}

/** Whether Router actually runs on a model other than the one its row shows. */
const routerDiffers = computed(() => {
  const effective = modelsView.value?.routerModel;
  if (!effective) return false;
  return !modelLabel("router").text.endsWith(`${effective.provider}/${effective.modelId}`);
});

async function saveRoleModel(roleKey: "default" | RoleName, choice: ModelChoice): Promise<boolean> {
  const ok = await savingModel.run(async () => {
    await props.client.call("PUT /api/models/defaults/:role", { role: roleKey }, choice);
  });
  if (ok) {
    pop.value = undefined;
    await loadModels();
    await props.refreshStatus();
  }
  return ok;
}

async function pickRoleModel(roleKey: "default" | RoleName, spec: ModelSpecView | null): Promise<void> {
  if (spec === null) return;
  const choice = switchModel(effectiveModel(roleKey), spec);
  if (await saveRoleModel(roleKey, choice)) {
    const label = MODEL_ROLES.find((r) => r.key === roleKey)?.label ?? roleKey;
    showToast(t("{role} now runs on {model}", { role: label, model: `${choice.provider}/${choice.modelId}` }));
  }
}

async function pickRoleLevel(roleKey: "default" | RoleName, level: ThinkingLevel): Promise<void> {
  const base = effectiveModel(roleKey);
  if (base === undefined) return;
  await saveRoleModel(roleKey, {
    provider: base.provider,
    modelId: base.modelId,
    ...(level === "off" ? {} : { thinkingLevel: level }),
  });
}

async function toggleExtension(role: RoleName, extName: string): Promise<void> {
  const currentRole = capabilities.value?.roles.find((r) => r.role === role);
  if (!currentRole || savingRole.busy.value) return;
  const has = currentRole.enabled.includes(extName);
  const next = has
    ? currentRole.enabled.filter((e) => e !== extName)
    : [...currentRole.enabled, extName];
  await savingRole.run(async () => {
    capabilities.value = await props.client.call(
      "PATCH /api/capabilities/roles/:role",
      { role },
      { extensions: next },
    );
  });
}

async function commitMaxTurns(role: RoleName, nextValue: number | null): Promise<void> {
  const currentRole = capabilities.value?.roles.find((r) => r.role === role);
  if (!currentRole || savingRole.busy.value) return;
  if ((currentRole.maxTurns ?? null) === nextValue) return;
  const ok = await savingRole.run(async () => {
    capabilities.value = await props.client.call(
      "PATCH /api/capabilities/roles/:role",
      { role },
      { maxTurns: nextValue },
    );
  });
  if (ok) {
    showToast(t("Updated the {role} turn limit", { role: ROLE_LABEL[role] }));
  }
}

function rolesUsingExtension(extName: string): string[] {
  return (capabilities.value?.roles ?? [])
    .filter((r) => r.enabled.includes(extName))
    .map((r) => ROLE_LABEL[r.role]);
}

async function reloadMcp(): Promise<void> {
  const ok = await reloadingMcp.run(async () => {
    capabilities.value = await props.client.call("POST /api/mcp/reload");
  });
  if (ok) {
    showToast(t("Reloaded MCP servers"));
  }
}

function copyText(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => undefined);
  showToast(t("Copied {text}", { text }));
}

const streamBadge = computed(() => {
  if (props.streamState === "connected") return { dot: "ok", label: t("Running") };
  if (props.streamState === "connecting") return { dot: "run", label: t("Connecting the live stream") };
  if (props.streamState === "reconnecting") return { dot: "run", label: t("Reconnecting the live stream::status") };
  return { dot: "bad", label: t("Live stream disconnected") };
});

const MODEL_PICK =
  "inline-flex h-(--ev-h-md) items-center gap-2 rounded-md border border-(--ev-input-border) bg-(--ev-well) px-2.5 text-left shadow-(--ev-shadow-well) transition-[border-color,box-shadow] duration-(--ev-fast) focus-visible:shadow-[var(--ev-shadow-well),var(--ring)] disabled:opacity-45 [&>.ico]:text-fg-subtle";
const STATUS_TEXT = "inline-flex items-center gap-1.75 text-xs whitespace-nowrap text-fg-muted";
const VALUE_TEXT = "text-right font-mono text-xs leading-[1.4] wrap-anywhere text-fg-muted";
</script>

<template>
  <section class="page-wrap overflow-y-auto">
        <div class="settings-content flex w-full flex-col gap-4 px-8 pt-6 pb-14 @max-[44.2857em]/vp:px-4 @max-[44.2857em]/vp:pt-4 @max-[44.2857em]/vp:pb-12">
          <template v-if="section === 'general'">
            <SectionHeader :title="t('General')" />
            <div :class="rows()">
              <div :class="row()">
                <div :class="rowMain()"><span :class="rowTitle()">{{ t("Language") }}</span></div>
                <Segmented :model-value="locale" :options="LOCALES.map((value) => ({ value, label: LOCALE_NAME[value], lang: value }))" :label="t('Language')" @update:model-value="setLocale" />
              </div>
              <div :class="row()">
                <div :class="rowMain()"><span :class="rowTitle()">{{ t("Theme") }}</span></div>
                <Segmented :model-value="themePref" :options="THEME_OPTIONS.map((option) => ({ value: option.key, label: option.label }))" :label="t('Theme')" @update:model-value="setTheme" />
              </div>
              <div :class="row()">
                <label :class="rowMain()" for="set-font"><span :class="rowTitle()">{{ t("Font") }}</span></label>
                <Input id="set-font" size="sm" inline class="w-55" :model-value="font" placeholder="Inter" spellcheck="false" autocomplete="off" @input="setFont(($event.target as HTMLInputElement).value)" />
              </div>
              <div :class="row()">
                <label :class="rowMain()" for="set-size"><span :class="rowTitle()">{{ t("Font size") }}</span></label>
                <Input id="set-size" size="sm" inline class="w-17 text-center num" type="number" inputmode="numeric" :min="TEXT_SIZE.min" :max="TEXT_SIZE.max" step="1" :model-value="textSize" @input="onSizeInput" @blur="onSizeBlur" />
              </div>
              <div :class="row()">
                <div :class="rowMain()">
                  <span :class="rowTitle()">{{ t("Desktop notifications") }}</span>
                  <span :class="ROW_DESC">{{ notifyHint }}</span>
                </div>
                <Switch :model-value="notifyOn" :disabled="notifyPermission === 'unsupported' || notifyPermission === 'denied'" :aria-label="t('Desktop notifications')" @update:model-value="toggleNotify" />
              </div>
            </div>
          </template>

          <template v-else-if="section === 'models' && item !== undefined">
            <p v-if="modelsError" class="error hint">{{ modelsError }}</p>
            <Skeleton v-else-if="modelsView === undefined" />
            <ProviderEditor v-else :client="client" :id="item" :view="modelsView" :reload-view="loadModels" />
          </template>

          <template v-else-if="section === 'models'">
            <SectionHeader :title="t('Models')" />
            <p v-if="modelsError" class="error hint">{{ modelsError }}</p>
            <Skeleton v-else-if="loadingModels && modelsView === undefined" />
            <template v-else-if="modelsView">
              <div v-if="modelsView.problems.length > 0" :class="banner('danger')">
                <Icon name="alert" size="sm" />
                <div>
                  <strong>{{ t("models.json has problems; those providers use built-in settings") }}</strong>
                  <ul>
                    <li v-for="(prob, idx) in modelsView.problems" :key="idx">{{ configProblemText(prob) }}</li>
                  </ul>
                </div>
              </div>
              <p v-if="savingModel.error.value" class="error hint">{{ savingModel.error.value }}</p>
              <div :class="rows()">
                <div v-for="roleRow in MODEL_ROLES" :key="roleRow.key" class="model-row-ctrl relative [&>.pop]:top-[calc(100%_-_calc(6px*var(--ev-scale)))] [&>.pop]:right-3" :class="row()">
                  <div :class="rowMain()">
                    <span :class="rowTitle()">
                      {{ roleRow.label }}
                      <span
                        v-if="roleRow.key === 'router' && routerDiffers"
                        :class="badge({ mono: true })"
                        :title="t('The model the Router runs on right now')"
                      >
                        {{
                          t("Running {model}", {
                            model: `${modelsView.routerModel?.provider}/${modelsView.routerModel?.modelId}`,
                          })
                        }}
                      </span>
                    </span>
                  </div>
                  <div v-if="rowLevels(roleRow.key).length > 1" class="relative [&>.pop]:top-[calc(100%_+_calc(4px*var(--ev-scale)))] [&>.pop]:left-0">
                    <button
                      type="button"
                      :class="[MODEL_PICK, 'w-26 text-sm leading-none font-medium text-fg']"
                      :aria-expanded="pop?.role === roleRow.key && pop.menu === 'level'"
                      :disabled="savingModel.busy.value"
                      :aria-label="t('{role} thinking level', { role: roleRow.label })"
                      @click="togglePop(roleRow.key, 'level')"
                    >
                      <Icon name="bulb" size="xs" />
                      <span class="spacer">{{ levelLabel(rowLevel(roleRow.key)) }}</span>
                      <Icon name="chevD" size="xs" />
                    </button>
                    <LevelMenu
                      v-if="pop?.role === roleRow.key && pop.menu === 'level'"
                      :levels="rowLevels(roleRow.key)"
                      :selected="rowLevel(roleRow.key)"
                      @pick="(level) => pickRoleLevel(roleRow.key, level)"
                      @close="pop = undefined"
                    />
                  </div>
                  <button
                    type="button"
                    :class="[
                      MODEL_PICK,
                      'w-[min(calc(260px*var(--ev-scale)),46%)]',
                      modelLabel(roleRow.key).inherited ? 'text-sm font-normal text-fg-subtle' : 'font-mono text-xs leading-none font-medium text-fg',
                    ]"
                    :disabled="availableModels.length === 0 || savingModel.busy.value"
                    :aria-expanded="pop?.role === roleRow.key && pop.menu === 'model'"
                    @click="togglePop(roleRow.key, 'model')"
                  >
                    <span class="ellipsis spacer">{{ modelLabel(roleRow.key).text }}</span>
                    <Icon name="chevD" size="xs" />
                  </button>
                  <ModelMenu
                    v-if="pop?.role === roleRow.key && pop.menu === 'model'"
                    :models="availableModels"
                    :selected="modelsView.defaults[roleRow.key]"
                    @pick="(spec) => pickRoleModel(roleRow.key, spec)"
                    @close="pop = undefined"
                  />
                </div>
              </div>

              <div :class="SECTION_T">
                <h3>{{ t("Providers") }}</h3>
                <span class="count">{{ configuredProviders.length }}/{{ modelsView.providers.length }}</span>
                <span class="spacer" />
                <Button v-if="configuredProviders.length > 0 && unconfiguredProviders.length > 0" variant="ghost" size="sm" @click="showAllProviders = !showAllProviders">
                  {{ showAllProviders ? t("Configured only") : t("Show all") }}
                </Button>
                <Button size="sm" :href="NEW_PROVIDER">
                  <Icon name="plus" size="xs" />
                  <span>{{ t("Add") }}</span>
                </Button>
              </div>
              <div :class="rows()">
                <a v-for="prov in visibleProviders" :key="prov.id" :class="row({ link: true })" :href="providerHref(prov.id)">
                  <span class="dot" :class="{ ok: prov.configured }" />
                  <div :class="rowMain()">
                    <span :class="rowTitle()">
                      <span>{{ prov.name }}</span>
                      <span v-if="prov.custom" :class="badge()">{{ prov.builtIn ? t("Modified") : t("Custom") }}</span>
                    </span>
                    <span :class="ROW_DESC">
                      <span v-if="prov.name !== prov.id" class="mono">{{ prov.id }} · </span>
                      {{ t("{n} model|{n} models", { n: prov.modelCount }) }}
                      <template v-if="prov.configured && prov.source"> · {{ prov.source }}</template>
                    </span>
                  </div>
                  <span v-if="prov.configured" :class="badge()">
                    <Icon name="key" size="xs" />
                    <span>{{ prov.authType === "oauth" ? "OAuth" : "API Key" }}</span>
                  </span>
                  <Icon name="chevR" size="xs" class="go" />
                </a>
              </div>

              <template v-if="availableModels.length > 0">
                <div :class="SECTION_T"><h3>{{ t("Available models") }}</h3></div>
                <div :class="PANEL">
                  <table :class="TABLE" class="table-fixed [&_tr>th]:px-2 [&_tr>td]:px-2 [&_td]:wrap-anywhere [&_td]:py-2 @max-[44.2857em]/vp:text-xs">
                    <thead>
                      <tr>
                        <th class="w-[30%]">{{ t("Model") }}</th>
                        <th class="w-[20%]">{{ t("Name") }}</th>
                        <th class="w-[18%]">{{ t("Context") }}</th>
                        <th class="w-[32%]">{{ t("Pricing") }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="entry in availableModels" :key="`${entry.provider}/${entry.modelId}`">
                        <td class="font-mono">{{ entry.provider }}/{{ entry.modelId }}</td>
                        <td>{{ entry.name }}</td>
                        <td class="num muted">{{ compactTokens(entry.contextWindow) }}</td>
                        <td class="muted">{{ formatModelMeta(entry) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>

              <template v-if="modelsView.profiles">
                <div :class="SECTION_T"><h3 title="~/.eevee/models.md">{{ t("Field notes") }}</h3></div>
                <div :class="PANEL">
                  <div class="panel-b msg-ai px-4 py-3.5">
                    <MarkdownText :source="modelsView.profiles" />
                  </div>
                </div>
              </template>
            </template>
          </template>

          <template v-else-if="section === 'roles'">
            <SectionHeader :title="t('Roles')" />
            <p v-if="capError || savingRole.error.value" class="error hint">
              {{ capError ?? savingRole.error.value }}
            </p>
            <Skeleton v-else-if="loadingCap && !capabilities" />
            <RoleSettings
              v-else-if="capabilities"
              :capabilities="capabilities"
              :busy="savingRole.busy.value"
              @toggle="toggleExtension"
              @max-turns="commitMaxTurns"
            />
          </template>

          <template v-else-if="section === 'mcp' && item !== undefined">
            <p v-if="capError" class="error hint">{{ capError }}</p>
            <Skeleton v-else-if="capabilities === undefined" />
            <McpEditor
              v-else
              :client="client"
              :name="item"
              :capabilities="capabilities"
              @changed="(view) => { applyCapabilities(view); void loadMcpEntries(); }"
            />
          </template>

          <template v-else-if="section === 'mcp'">
            <SectionHeader :title="t('MCP & extensions')">
              <Button size="sm" :disabled="reloadingMcp.busy.value" @click="reloadMcp">
                <Icon name="refresh" size="xs" :spin="reloadingMcp.busy.value" />
                <span>{{ t("Reload") }}</span>
              </Button>
            </SectionHeader>
            <p v-if="capError || reloadingMcp.error.value" class="error hint">
              {{ capError ?? reloadingMcp.error.value }}
            </p>
            <Skeleton v-else-if="loadingCap && !capabilities" />
            <template v-else-if="capabilities">
              <div v-if="capabilities.problems.length > 0" :class="banner('danger')">
                <Icon name="alert" size="sm" />
                <div>
                  <strong>{{ t("{n} problem|{n} problems", { n: capabilities.problems.length }) }}</strong>
                  <ul>
                    <li v-for="(prob, idx) in capabilities.problems" :key="idx">
                      <a v-if="problemServer(prob)" :href="serverHref(problemServer(prob) ?? '')">
                        {{ configProblemText(prob) }}
                      </a>
                      <template v-else>{{ configProblemText(prob) }}</template>
                    </li>
                  </ul>
                </div>
              </div>
              <div :class="SECTION_T">
                <h3 title="~/.eevee/mcp.json">{{ t("MCP servers") }}</h3>
                <span class="spacer" />
                <Button size="sm" :href="NEW_SERVER">
                  <Icon name="plus" size="xs" />
                  <span>{{ t("Add") }}</span>
                </Button>
              </div>
              <p v-if="togglingServer.error.value" class="error hint">{{ togglingServer.error.value }}</p>
              <div :class="rows()">
                <div v-if="capabilities.mcp.length === 0" :class="row()">
                  <span class="muted">{{ t("No MCP servers") }}</span>
                </div>
                <div v-for="server in capabilities.mcp" :key="server.name" :class="row({ overlay: true })">
                  <a :class="[rowMain(), ROW_LINK]" :href="serverHref(server.name)">
                    <span :class="rowTitle()">
                      <span class="mono">mcp.{{ server.name }}</span>
                      <span :class="badge({ mono: true })" :title="t('How its tools are offered')">{{ server.exposure }}</span>
                    </span>
                    <span :class="ROW_DESC">
                      {{ t("{n} tool|{n} tools", { n: server.tools }) }}
                      <template v-if="rolesUsingExtension(`mcp.${server.name}`).length > 0">
                        · {{ rolesUsingExtension(`mcp.${server.name}`).join(t(", ")) }}
                      </template>
                    </span>
                    <span v-if="server.error" class="err">{{ configIssueText(server.error) }}</span>
                  </a>
                  <span :class="STATUS_TEXT">
                    <span class="dot" :class="MCP_STATE_LABEL[server.state].dot" />
                    <span>{{ MCP_STATE_LABEL[server.state].label }}</span>
                  </span>
                  <Switch :model-value="server.state !== 'disabled'" :disabled="togglingServer.busy.value || mcpEntries?.[server.name] === undefined" :aria-label="t('Enable {name}', { name: server.name })" @update:model-value="toggleServer(server.name)" />
                </div>
              </div>
            </template>
          </template>

          <template v-else-if="section === 'engine'">
            <SectionHeader title="Engine" />
            <div :class="rows()">
              <div :class="row()">
                <div :class="rowMain()"><span :class="rowTitle()">{{ t("Status") }}</span></div>
                <span :class="STATUS_TEXT">
                  <span class="dot" :class="streamBadge.dot" />
                  <span>{{ streamBadge.label }}</span>
                </span>
              </div>
              <div :class="row()">
                <div :class="rowMain()"><span :class="rowTitle()">{{ t("Version") }}</span></div>
                <span :class="VALUE_TEXT">{{ status?.version ?? "—" }}</span>
              </div>
              <div :class="row()">
                <div :class="rowMain()"><span :class="rowTitle()">{{ t("Address") }}</span></div>
                <span :class="VALUE_TEXT">{{ status ? `http://127.0.0.1:${status.port}/` : "—" }}</span>
              </div>
              <div :class="row()">
                <div :class="rowMain()"><span :class="rowTitle()">bootId</span></div>
                <span :class="VALUE_TEXT">{{ status?.bootId ?? "—" }}</span>
              </div>
            </div>
            <div :class="SECTION_T"><h3>{{ t("Restart") }}</h3></div>
            <div :class="CODELINE">
              <code>{{ RESTART }}</code>
              <Button variant="ghost" size="sm" icon :aria-label="t('Copy the restart command')" @click="copyText(RESTART)">
                <Icon name="copy" size="xs" />
              </Button>
            </div>
            <p class="hint">{{ t("Stops any running background jobs") }}</p>
          </template>
        </div>
  </section>
</template>
