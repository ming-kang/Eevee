<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type {
  CapabilitiesView,
  EngineStatus,
  McpServerView,
  ModelSpecView,
} from "@shared/api/contract.ts";
import {
  type ModelChoice,
  type ModelDefaults,
  pickModel,
  type RoleName,
  type ThinkingLevel,
} from "@shared/contracts/index.ts";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { configIssueText, configProblemText, errorText } from "../errors.ts";
import { ROLE_LABEL } from "../labels.ts";
import { LOCALE_NAME, LOCALES, locale, setLocale, t } from "../i18n.ts";
import type { IconName } from "../icons.ts";
import { levelsOf, switchModel, levelLabel } from "../model-choice.ts";
import { useModelsView } from "../models-view.ts";
import { formatRoute, NEW_ITEM, type SettingsSection } from "../router.ts";
import { vSeg } from "../dom.ts";
import { PALETTE_LABELS } from "../projects.ts";
import type { StreamState } from "../stream.ts";
import { useSubmit } from "../submit.ts";
import { THEME_PALETTES, type ThemePreference, useTheme, useTypography } from "../theme.ts";
import { showToast } from "../toasts.ts";
import { readTextSize, TEXT_SIZE } from "../typography.ts";
import { notifyEnabled, notifySupported, setNotifyEnabled } from "../use-notifications.ts";
import Icon from "./Icon.vue";
import LevelMenu from "./LevelMenu.vue";
import MarkdownText from "./MarkdownText.vue";
import McpEditor from "./McpEditor.vue";
import ModelMenu from "./ModelMenu.vue";
import ProviderEditor from "./ProviderEditor.vue";
import RoleSettings from "./RoleSettings.vue";
import Skeleton from "./Skeleton.vue";

const props = defineProps<{
  client: Client;
  section: SettingsSection;
  /** The provider or MCP server open on its own page, or `NEW_ITEM` to add one. */
  item?: string | undefined;
  status: EngineStatus | undefined;
  streamState: StreamState;
  refreshStatus: () => Promise<void>;
}>();

const { preference: themePref, palette: activePalette, resolved: resolvedTheme, setTheme, setPalette } = useTheme();
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

const NEW_PROVIDER = formatRoute({ name: "settings", section: "models", item: NEW_ITEM });
const NEW_SERVER = formatRoute({ name: "settings", section: "mcp", item: NEW_ITEM });
const providerHref = (id: string) => formatRoute({ name: "settings", section: "models", item: id });
const serverHref = (name: string) => formatRoute({ name: "settings", section: "mcp", item: name });

const MCP_STATE_LABEL: Record<McpServerView["state"], { dot: string; label: string }> = {
  connected: { dot: "ok", label: t("Connected") },
  connecting: { dot: "run", label: t("Connecting") },
  failed: { dot: "bad", label: t("Failed") },
  disabled: { dot: "", label: t("Disabled") },
};

const SECTIONS: { key: SettingsSection; label: string; icon: IconName }[] = [
  { key: "general", label: t("General"), icon: "sliders" },
  { key: "models", label: t("Models"), icon: "cpu" },
  { key: "roles", label: t("Roles"), icon: "puzzle" },
  { key: "mcp", label: t("MCP & extensions"), icon: "plug" },
  { key: "engine", label: "Engine", icon: "server" },
];

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

/** mcp.json's entries, which the server list switches on and off. */
const mcpEntries = ref<Record<string, Record<string, unknown>>>();
const togglingServer = useSubmit();

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
    await props.client.call("POST /api/settings/models", {
      ...(roleKey === "default" ? {} : { role: roleKey }),
      ...choice,
    });
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
      "POST /api/capabilities/roles/:role",
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
      "POST /api/capabilities/roles/:role",
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
</script>

<template>
  <section class="page-wrap">
    <header class="header">
      <h1>{{ t("Settings") }}</h1>
    </header>
    <div class="settings">
      <nav class="set-nav" :aria-label="t('Settings sections')">
        <a
          v-for="item in SECTIONS"
          :key="item.key"
          class="nav-item"
          :class="{ on: section === item.key }"
          :aria-current="section === item.key ? 'page' : undefined"
          :href="`#/settings/${item.key}`"
        >
          <Icon :name="item.icon" size="sm" />
          <span class="spacer">{{ item.label }}</span>
          <span
            v-if="item.key === 'mcp' && (capabilities?.problems.length ?? 0) > 0"
            class="dot bad"
            :title="t('Some servers or extensions failed to load')"
          />
          <span v-if="item.key === 'mcp' && (capabilities?.problems.length ?? 0) > 0" class="sr">
            {{ t("(some servers or extensions failed to load)") }}
          </span>
        </a>
      </nav>

      <div class="set-body">
        <div class="set-inner">
          <template v-if="section === 'general'">
            <header class="set-head"><h2>{{ t("General") }}</h2></header>
            <div class="rows">
              <div class="row">
                <div class="r-main"><span class="r-t">{{ t("Language") }}</span></div>
                <div v-seg class="seg sm" role="group" :aria-label="t('Language')">
                  <button
                    v-for="option in LOCALES"
                    :key="option"
                    type="button"
                    :lang="option"
                    :class="{ on: locale === option }"
                    :aria-pressed="locale === option"
                    @click="setLocale(option)"
                  >
                    {{ LOCALE_NAME[option] }}
                  </button>
                </div>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">{{ t("Theme") }}</span></div>
                <div v-seg class="seg sm" role="group" :aria-label="t('Theme')">
                  <button
                    v-for="option in THEME_OPTIONS"
                    :key="option.key"
                    type="button"
                    :class="{ on: themePref === option.key }"
                    :aria-pressed="themePref === option.key"
                    @click="setTheme(option.key)"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </div>
              <div class="row row-palettes">
                <div class="r-main">
                  <span class="r-t">{{ t("Color palette") }}</span>
                  <span class="r-d">{{ t("Applies to both light and dark modes") }}</span>
                </div>
                <div class="pal-grid" role="group" :aria-label="t('Color palette')">
                  <button
                    v-for="sw in THEME_PALETTES"
                    :key="sw.id"
                    type="button"
                    class="pal-card"
                    :class="{ on: activePalette === sw.id }"
                    :aria-pressed="activePalette === sw.id"
                    @click="setPalette(sw.id)"
                  >
                    <span
                      class="pal-chip"
                      aria-hidden="true"
                      :style="{
                        '--sw-side': (resolvedTheme === 'dark' ? sw.dark : sw.light).sidebar,
                        '--sw-canvas': (resolvedTheme === 'dark' ? sw.dark : sw.light).canvas,
                        '--sw-primary': (resolvedTheme === 'dark' ? sw.dark : sw.light).primary,
                      }"
                    >
                      <i class="pal-chip-side" />
                      <i class="pal-chip-canvas"><b class="pal-chip-dot" /></i>
                    </span>
                    <span class="pal-name">{{ PALETTE_LABELS[sw.id]() }}</span>
                  </button>
                </div>
              </div>
              <div class="row">
                <label class="r-main" for="set-font"><span class="r-t">{{ t("Font") }}</span></label>
                <input
                  id="set-font"
                  class="input pref"
                  :value="font"
                  placeholder="Inter"
                  spellcheck="false"
                  autocomplete="off"
                  @input="setFont(($event.target as HTMLInputElement).value)"
                />
              </div>
              <div class="row">
                <label class="r-main" for="set-size"><span class="r-t">{{ t("Font size") }}</span></label>
                <input
                  id="set-size"
                  class="input pref size num"
                  type="number"
                  inputmode="numeric"
                  :min="TEXT_SIZE.min"
                  :max="TEXT_SIZE.max"
                  step="1"
                  :value="textSize"
                  @input="onSizeInput"
                  @blur="onSizeBlur"
                />
              </div>
              <div class="row">
                <div class="r-main">
                  <span class="r-t">{{ t("Desktop notifications") }}</span>
                  <span class="r-d">{{ notifyHint }}</span>
                </div>
                <button
                  type="button"
                  class="switch"
                  :class="{ on: notifyOn }"
                  :disabled="notifyPermission === 'unsupported' || notifyPermission === 'denied'"
                  :aria-pressed="notifyOn"
                  :aria-label="t('Desktop notifications')"
                  @click="toggleNotify"
                />
              </div>
            </div>
          </template>

          <template v-else-if="section === 'models' && item !== undefined">
            <p v-if="modelsError" class="error hint">{{ modelsError }}</p>
            <Skeleton v-else-if="modelsView === undefined" />
            <ProviderEditor v-else :client="client" :id="item" :view="modelsView" :reload-view="loadModels" />
          </template>

          <template v-else-if="section === 'models'">
            <header class="set-head"><h2>{{ t("Models") }}</h2></header>
            <p v-if="modelsError" class="error hint">{{ modelsError }}</p>
            <Skeleton v-else-if="loadingModels && modelsView === undefined" />
            <template v-else-if="modelsView">
              <div v-if="modelsView.problems.length > 0" class="banner bad">
                <Icon name="alert" size="sm" />
                <div>
                  <strong>{{ t("models.json has problems; those providers use built-in settings") }}</strong>
                  <ul>
                    <li v-for="(prob, idx) in modelsView.problems" :key="idx">{{ configProblemText(prob) }}</li>
                  </ul>
                </div>
              </div>
              <p v-if="savingModel.error.value" class="error hint">{{ savingModel.error.value }}</p>
              <div class="rows">
                <div v-for="roleRow in MODEL_ROLES" :key="roleRow.key" class="row model-row-ctrl">
                  <div class="r-main">
                    <span class="r-t">
                      {{ roleRow.label }}
                      <span
                        v-if="roleRow.key === 'router' && routerDiffers"
                        class="chip mono"
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
                  <div v-if="rowLevels(roleRow.key).length > 1" class="level-slot">
                    <button
                      type="button"
                      class="model-pick level"
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
                    class="model-pick"
                    :class="{ inherit: modelLabel(roleRow.key).inherited }"
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

              <div class="section-t">
                <h3>{{ t("Providers") }}</h3>
                <span class="count">{{ configuredProviders.length }}/{{ modelsView.providers.length }}</span>
                <span class="spacer" />
                <button
                  v-if="configuredProviders.length > 0 && unconfiguredProviders.length > 0"
                  type="button"
                  class="btn sm ghost"
                  @click="showAllProviders = !showAllProviders"
                >
                  {{ showAllProviders ? t("Configured only") : t("Show all") }}
                </button>
                <a class="btn sm" :href="NEW_PROVIDER">
                  <Icon name="plus" size="xs" />
                  <span>{{ t("Add") }}</span>
                </a>
              </div>
              <div class="rows">
                <a v-for="prov in visibleProviders" :key="prov.id" class="row link" :href="providerHref(prov.id)">
                  <span class="dot" :class="{ ok: prov.configured }" />
                  <div class="r-main">
                    <span class="r-t">
                      <span>{{ prov.name }}</span>
                      <span v-if="prov.custom" class="chip">{{ prov.builtIn ? t("Modified") : t("Custom") }}</span>
                    </span>
                    <span class="r-d">
                      <span v-if="prov.name !== prov.id" class="mono">{{ prov.id }} · </span>
                      {{ t("{n} model|{n} models", { n: prov.modelCount }) }}
                      <template v-if="prov.configured && prov.source"> · {{ prov.source }}</template>
                    </span>
                  </div>
                  <span v-if="prov.configured" class="chip">
                    <Icon name="key" size="xs" />
                    <span>{{ prov.authType === "oauth" ? "OAuth" : "API Key" }}</span>
                  </span>
                  <Icon name="chevR" size="xs" class="go" />
                </a>
              </div>

              <template v-if="availableModels.length > 0">
                <div class="section-t"><h3>{{ t("Available models") }}</h3></div>
                <div class="panel">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>{{ t("Model") }}</th>
                        <th>{{ t("Name") }}</th>
                        <th>{{ t("Context") }}</th>
                        <th class="hide-sm">{{ t("Pricing") }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="entry in availableModels" :key="`${entry.provider}/${entry.modelId}`">
                        <td class="mono">{{ entry.provider }}/{{ entry.modelId }}</td>
                        <td class="name">{{ entry.name }}</td>
                        <td class="num muted">{{ compactTokens(entry.contextWindow) }}</td>
                        <td class="hide-sm muted">{{ formatModelMeta(entry) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>

              <template v-if="modelsView.profiles">
                <div class="section-t"><h3 title="~/.eevee/models.md">{{ t("Field notes") }}</h3></div>
                <div class="panel">
                  <div class="panel-b msg-ai">
                    <MarkdownText :source="modelsView.profiles" />
                  </div>
                </div>
              </template>
            </template>
          </template>

          <template v-else-if="section === 'roles'">
            <header class="set-head"><h2>{{ t("Roles") }}</h2></header>
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
            <header class="set-head">
              <h2>{{ t("MCP & extensions") }}</h2>
              <button type="button" class="btn sm" :disabled="reloadingMcp.busy.value" @click="reloadMcp">
                <Icon name="refresh" size="xs" :spin="reloadingMcp.busy.value" />
                <span>{{ t("Reload") }}</span>
              </button>
            </header>
            <p v-if="capError || reloadingMcp.error.value" class="error hint">
              {{ capError ?? reloadingMcp.error.value }}
            </p>
            <Skeleton v-else-if="loadingCap && !capabilities" />
            <template v-else-if="capabilities">
              <div v-if="capabilities.problems.length > 0" class="banner bad">
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
              <div class="section-t">
                <h3 title="~/.eevee/mcp.json">{{ t("MCP servers") }}</h3>
                <span class="spacer" />
                <a class="btn sm" :href="NEW_SERVER">
                  <Icon name="plus" size="xs" />
                  <span>{{ t("Add") }}</span>
                </a>
              </div>
              <p v-if="togglingServer.error.value" class="error hint">{{ togglingServer.error.value }}</p>
              <div class="rows">
                <div v-if="capabilities.mcp.length === 0" class="row">
                  <span class="muted">{{ t("No MCP servers") }}</span>
                </div>
                <div v-for="server in capabilities.mcp" :key="server.name" class="row has-link">
                  <a class="r-main row-link" :href="serverHref(server.name)">
                    <span class="r-t">
                      <span class="mono">mcp.{{ server.name }}</span>
                      <span class="chip mono" :title="t('How its tools are offered')">{{ server.exposure }}</span>
                    </span>
                    <span class="r-d">
                      {{ t("{n} tool|{n} tools", { n: server.tools }) }}
                      <template v-if="rolesUsingExtension(`mcp.${server.name}`).length > 0">
                        · {{ rolesUsingExtension(`mcp.${server.name}`).join(t(", ")) }}
                      </template>
                    </span>
                    <span v-if="server.error" class="err">{{ configIssueText(server.error) }}</span>
                  </a>
                  <span class="status-text">
                    <span class="dot" :class="MCP_STATE_LABEL[server.state].dot" />
                    <span>{{ MCP_STATE_LABEL[server.state].label }}</span>
                  </span>
                  <button
                    type="button"
                    class="switch"
                    :class="{ on: server.state !== 'disabled' }"
                    :disabled="togglingServer.busy.value || mcpEntries?.[server.name] === undefined"
                    :aria-pressed="server.state !== 'disabled'"
                    :aria-label="t('Enable {name}', { name: server.name })"
                    @click="toggleServer(server.name)"
                  />
                </div>
              </div>
            </template>
          </template>

          <template v-else-if="section === 'engine'">
            <header class="set-head"><h2>Engine</h2></header>
            <div class="rows">
              <div class="row">
                <div class="r-main"><span class="r-t">{{ t("Status") }}</span></div>
                <span class="status-text">
                  <span class="dot" :class="streamBadge.dot" />
                  <span>{{ streamBadge.label }}</span>
                </span>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">{{ t("Version") }}</span></div>
                <span class="value">{{ status?.version ?? "—" }}</span>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">{{ t("Address") }}</span></div>
                <span class="value">{{ status ? `http://127.0.0.1:${status.port}/` : "—" }}</span>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">bootId</span></div>
                <span class="value">{{ status?.bootId ?? "—" }}</span>
              </div>
            </div>
            <div class="section-t"><h3>{{ t("Restart") }}</h3></div>
            <div class="codeline">
              <code>{{ RESTART }}</code>
              <button type="button" class="btn ghost sm icon" :aria-label="t('Copy the restart command')" @click="copyText(RESTART)">
                <Icon name="copy" size="xs" />
              </button>
            </div>
            <p class="hint">{{ t("Stops any running background jobs") }}</p>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
