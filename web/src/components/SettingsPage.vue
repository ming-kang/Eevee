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
import type { StreamState } from "../stream.ts";
import { useSubmit } from "../submit.ts";
import { type ThemePreference, useTheme, useTypography } from "../theme.ts";
import { showToast } from "../toasts.ts";
import { readTextSize, TEXT_SIZE } from "../typography.ts";
import Icon from "./Icon.vue";
import LevelMenu from "./LevelMenu.vue";
import MarkdownText from "./MarkdownText.vue";
import McpEditor from "./McpEditor.vue";
import ModelMenu from "./ModelMenu.vue";
import ProviderEditor from "./ProviderEditor.vue";
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

defineEmits<{
  "open-side": [];
}>();

const { preference: themePref, setTheme } = useTheme();
const { size: textSize, font, setTextSize, setFont } = useTypography();

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
const turnDrafts = ref<Record<RoleName, string>>({
  router: "",
  worker: "",
  dreamer: "",
});

const MODEL_ROLES: { key: "default" | RoleName; label: string }[] = [
  { key: "default", label: t("全局默认") },
  { key: "router", label: "Router" },
  { key: "worker", label: "Worker" },
  { key: "dreamer", label: "Dreamer" },
];

const THEME_OPTIONS: { key: ThemePreference; label: string }[] = [
  { key: "system", label: t("跟随系统") },
  { key: "light", label: t("浅色") },
  { key: "dark", label: t("深色") },
];

const RESTART = "eevee stop && eevee start";

const NEW_PROVIDER = formatRoute({ name: "settings", section: "models", item: NEW_ITEM });
const NEW_SERVER = formatRoute({ name: "settings", section: "mcp", item: NEW_ITEM });
const providerHref = (id: string) => formatRoute({ name: "settings", section: "models", item: id });
const serverHref = (name: string) => formatRoute({ name: "settings", section: "mcp", item: name });

const MCP_STATE_LABEL: Record<McpServerView["state"], { dot: string; label: string }> = {
  connected: { dot: "ok", label: t("已连接") },
  connecting: { dot: "run", label: t("连接中") },
  failed: { dot: "bad", label: t("失败") },
  disabled: { dot: "", label: t("已停用") },
};

const SECTIONS: { key: SettingsSection; label: string; icon: IconName }[] = [
  { key: "general", label: t("通用"), icon: "sliders" },
  { key: "models", label: t("模型::list"), icon: "cpu" },
  { key: "roles", label: t("角色能力"), icon: "puzzle" },
  { key: "mcp", label: t("MCP 与扩展"), icon: "plug" },
  { key: "engine", label: "Engine", icon: "server" },
];

function syncTurnDrafts(cap: CapabilitiesView): void {
  const next: Record<RoleName, string> = { router: "", worker: "", dreamer: "" };
  for (const r of cap.roles) {
    next[r.role] = r.maxTurns !== undefined ? String(r.maxTurns) : "";
  }
  turnDrafts.value = next;
}

async function loadCapabilities(quiet = false): Promise<void> {
  loadingCap.value = !quiet;
  capError.value = undefined;
  try {
    const view = await props.client.call("GET /api/capabilities");
    capabilities.value = view;
    syncTurnDrafts(view);
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
  syncTurnDrafts(view);
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
    ? t("{n} 小时", { n: +(seconds / 3600).toFixed(1) })
    : t("{n} 分钟", { n: Math.round(seconds / 60) });
}

function formatModelMeta(model: ModelSpecView): string {
  const parts: string[] = [];
  if (model.cost.input || model.cost.output) {
    parts.push(
      t("输入 {price}/M", { price: `$${model.cost.input}` }),
      t("输出 {price}/M", { price: `$${model.cost.output}` }),
    );
  }
  if (model.cost.cacheRead) parts.push(t("缓存读 {price}/M", { price: `$${model.cost.cacheRead}` }));
  if (model.cacheShortSeconds) {
    parts.push(t("缓存 {tokens}", { tokens: formatCacheDuration(model.cacheShortSeconds) }));
  }
  if (model.reasoning) parts.push(t("推理"));
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
    return { text: t("跟随默认 · {model}", { model: `${effective.provider}/${effective.modelId}` }), inherited: true };
  }
  return { text: t("未设置"), inherited: true };
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
    showToast(t("已将 {role} 模型设为 {model}", { role: label, model: `${choice.provider}/${choice.modelId}` }));
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
  const ok = await savingRole.run(async () => {
    capabilities.value = await props.client.call(
      "POST /api/capabilities/roles/:role",
      { role },
      { extensions: next },
    );
  });
  if (ok && capabilities.value) {
    syncTurnDrafts(capabilities.value);
  }
}

async function commitMaxTurns(role: RoleName): Promise<void> {
  const currentRole = capabilities.value?.roles.find((r) => r.role === role);
  if (!currentRole || savingRole.busy.value) return;
  const raw = (turnDrafts.value[role] ?? "").trim();
  const nextValue = raw === "" ? null : Number(raw);
  if (nextValue !== null && (!Number.isInteger(nextValue) || nextValue < 1)) {
    showToast(t("轮次上限应为正整数，或留空恢复默认"), "error");
    turnDrafts.value[role] = currentRole.maxTurns !== undefined ? String(currentRole.maxTurns) : "";
    return;
  }
  if ((currentRole.maxTurns ?? null) === nextValue) return;
  const ok = await savingRole.run(async () => {
    capabilities.value = await props.client.call(
      "POST /api/capabilities/roles/:role",
      { role },
      { maxTurns: nextValue },
    );
  });
  if (ok && capabilities.value) {
    syncTurnDrafts(capabilities.value);
    showToast(t("已更新 {role} 轮次上限", { role: ROLE_LABEL[role] }));
  }
}

function mcpFailed(extName: string): boolean {
  return (
    capabilities.value?.mcp.some((m) => `mcp.${m.name}` === extName && m.state === "failed") ??
    false
  );
}

function rolesUsingExtension(extName: string): string[] {
  return (capabilities.value?.roles ?? [])
    .filter((r) => r.enabled.includes(extName))
    .map((r) => ROLE_LABEL[r.role]);
}

/** Extensions a role still enables though they are no longer installed, listed so they can be turned off. */
const uninstalledExtensions = computed(() => {
  const cap = capabilities.value;
  if (!cap) return [];
  const installed = new Set(cap.available.map((e) => e.name));
  return [...new Set(cap.roles.flatMap((r) => r.enabled))].filter((name) => !installed.has(name));
});

const builtInCount = computed(() => {
  const set = new Set<string>();
  for (const r of capabilities.value?.roles ?? []) {
    for (const ext of r.builtIn) set.add(ext);
  }
  return set.size;
});

async function reloadMcp(): Promise<void> {
  const ok = await reloadingMcp.run(async () => {
    capabilities.value = await props.client.call("POST /api/mcp/reload");
  });
  if (ok && capabilities.value) {
    syncTurnDrafts(capabilities.value);
    showToast(t("已重新加载 MCP 与用户扩展"));
  }
}

function copyText(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => undefined);
  showToast(t("已复制 {text}", { text }));
}

const streamBadge = computed(() => {
  if (props.streamState === "connected") return { dot: "ok", label: t("运行中") };
  if (props.streamState === "connecting") return { dot: "run", label: t("正在连接实时流") };
  if (props.streamState === "reconnecting") return { dot: "run", label: t("实时流重连中") };
  return { dot: "bad", label: t("实时流已断开") };
});
</script>

<template>
  <section class="page-wrap">
    <header class="header">
      <button type="button" class="btn ghost sm icon menu-btn" :aria-label="t('菜单')" @click="$emit('open-side')">
        <Icon name="menu" size="sm" />
      </button>
      <h1>{{ t("设置") }}</h1>
    </header>
    <div class="settings">
      <nav class="set-nav" :aria-label="t('设置分类')">
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
            :title="t('存在连接或扩展加载问题')"
          />
          <span v-if="item.key === 'mcp' && (capabilities?.problems.length ?? 0) > 0" class="sr">
            {{ t("（存在连接或扩展加载问题）") }}
          </span>
        </a>
      </nav>

      <div class="set-body">
        <div class="set-inner">
          <template v-if="section === 'general'">
            <header class="set-head"><h2>{{ t("通用") }}</h2></header>
            <div class="rows">
              <div class="row">
                <div class="r-main"><span class="r-t">{{ t("语言") }}</span></div>
                <div v-seg class="seg sm" role="group" :aria-label="t('语言')">
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
                <div class="r-main"><span class="r-t">{{ t("主题") }}</span></div>
                <div v-seg class="seg sm" role="group" :aria-label="t('主题')">
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
              <div class="row">
                <label class="r-main" for="set-font"><span class="r-t">{{ t("字体") }}</span></label>
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
                <label class="r-main" for="set-size"><span class="r-t">{{ t("字号") }}</span></label>
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
            </div>
          </template>

          <template v-else-if="section === 'models' && item !== undefined">
            <p v-if="modelsError" class="error hint">{{ modelsError }}</p>
            <Skeleton v-else-if="modelsView === undefined" />
            <ProviderEditor v-else :client="client" :id="item" :view="modelsView" :reload-view="loadModels" />
          </template>

          <template v-else-if="section === 'models'">
            <header class="set-head"><h2>{{ t("模型::list") }}</h2></header>
            <p v-if="modelsError" class="error hint">{{ modelsError }}</p>
            <Skeleton v-else-if="loadingModels && modelsView === undefined" />
            <template v-else-if="modelsView">
              <div v-if="modelsView.problems.length > 0" class="banner bad">
                <Icon name="alert" size="sm" />
                <div>
                  <strong>{{ t("models.json 有问题，相关 Provider 沿用内置设置") }}</strong>
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
                        :title="t('Router 当前实际使用的模型')"
                      >
                        {{
                          t("生效 {model}", {
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
                      :aria-label="t('{role} 的思考档位', { role: roleRow.label })"
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
                <h3>{{ t("Provider::list") }}</h3>
                <span class="count">{{ configuredProviders.length }}/{{ modelsView.providers.length }}</span>
                <span class="spacer" />
                <button
                  v-if="configuredProviders.length > 0 && unconfiguredProviders.length > 0"
                  type="button"
                  class="btn sm ghost"
                  @click="showAllProviders = !showAllProviders"
                >
                  {{ showAllProviders ? t("仅已配置") : t("显示全部") }}
                </button>
                <a class="btn sm" :href="NEW_PROVIDER">
                  <Icon name="plus" size="xs" />
                  <span>{{ t("添加") }}</span>
                </a>
              </div>
              <div class="rows">
                <a v-for="prov in visibleProviders" :key="prov.id" class="row link" :href="providerHref(prov.id)">
                  <span class="dot" :class="{ ok: prov.configured }" />
                  <div class="r-main">
                    <span class="r-t">
                      <span>{{ prov.name }}</span>
                      <span v-if="prov.custom" class="chip">{{ prov.builtIn ? t("已修改") : t("自定义") }}</span>
                    </span>
                    <span class="r-d">
                      <span v-if="prov.name !== prov.id" class="mono">{{ prov.id }} · </span>
                      {{ t("{n} 个模型", { n: prov.modelCount }) }}
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
                <div class="section-t"><h3>{{ t("可用模型") }}</h3></div>
                <div class="panel">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>{{ t("模型") }}</th>
                        <th>{{ t("名称") }}</th>
                        <th>{{ t("上下文") }}</th>
                        <th class="hide-sm">{{ t("定价") }}</th>
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
                <div class="section-t"><h3 title="~/.eevee/models.md">{{ t("使用经验") }}</h3></div>
                <div class="panel">
                  <div class="panel-b msg-ai">
                    <MarkdownText :source="modelsView.profiles" />
                  </div>
                </div>
              </template>
            </template>
          </template>

          <template v-else-if="section === 'roles'">
            <header class="set-head"><h2>{{ t("角色能力") }}</h2></header>
            <p v-if="capError || savingRole.error.value" class="error hint">
              {{ capError ?? savingRole.error.value }}
            </p>
            <Skeleton v-else-if="loadingCap && !capabilities" />
            <div v-else-if="capabilities" class="panel">
              <table class="matrix">
                <thead>
                  <tr>
                    <th>{{ t("扩展") }}</th>
                    <th v-for="roleItem in capabilities.roles" :key="roleItem.role">
                      {{ ROLE_LABEL[roleItem.role] }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="capabilities.available.length === 0">
                    <td colspan="4" class="muted">{{ t("没有可选扩展") }}</td>
                  </tr>
                  <tr v-for="ext in capabilities.available" :key="ext.name">
                    <td>
                      <div class="ext">
                        <b>
                          <Icon :name="ext.name.startsWith('mcp.') ? 'plug' : 'puzzle'" size="xs" />
                          <span>{{ ext.name }}</span>
                          <span v-if="mcpFailed(ext.name)" class="dot bad" :title="t('MCP 服务器连接失败')" />
                        </b>
                        <span>{{ t("{n} 个工具", { n: ext.tools }) }}</span>
                      </div>
                    </td>
                    <td v-for="roleItem in capabilities.roles" :key="roleItem.role">
                      <button
                        type="button"
                        class="switch"
                        :class="{ on: roleItem.enabled.includes(ext.name) }"
                        :disabled="savingRole.busy.value"
                        :aria-label="t('{role} 启用 {extension}', { role: ROLE_LABEL[roleItem.role], extension: ext.name })"
                        :aria-pressed="roleItem.enabled.includes(ext.name)"
                        @click="toggleExtension(roleItem.role, ext.name)"
                      />
                    </td>
                  </tr>
                  <tr v-for="name in uninstalledExtensions" :key="name">
                    <td>
                      <div class="ext">
                        <b>
                          <Icon :name="name.startsWith('mcp.') ? 'plug' : 'puzzle'" size="xs" />
                          <span>{{ name }}</span>
                          <span class="dot bad" />
                        </b>
                        <span>{{ t("未安装") }}</span>
                      </div>
                    </td>
                    <td v-for="roleItem in capabilities.roles" :key="roleItem.role">
                      <button
                        v-if="roleItem.enabled.includes(name)"
                        type="button"
                        class="switch on"
                        :disabled="savingRole.busy.value"
                        :aria-label="t('{role} 启用 {extension}', { role: ROLE_LABEL[roleItem.role], extension: name })"
                        aria-pressed="true"
                        @click="toggleExtension(roleItem.role, name)"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <div class="ext" :title="t('settings.json 中的 roles.<role>.maxTurns')">
                        <b>{{ t("轮次上限") }}</b>
                      </div>
                    </td>
                    <td v-for="roleItem in capabilities.roles" :key="roleItem.role">
                      <input
                        v-model="turnDrafts[roleItem.role]"
                        class="input mono"
                        :placeholder="t('默认')"
                        :aria-label="t('{role} 轮次上限', { role: ROLE_LABEL[roleItem.role] })"
                        :disabled="savingRole.busy.value"
                        @change="commitMaxTurns(roleItem.role)"
                      />
                    </td>
                  </tr>
                  <tr class="builtin">
                    <td>
                      <div class="ext" :title="t('始终启用')">
                        <b>
                          <Icon name="lock" size="xs" />
                          <span>{{ t("自带扩展") }}</span>
                        </b>
                      </div>
                    </td>
                    <td v-for="roleItem in capabilities.roles" :key="roleItem.role">
                      <div class="builtin-list">
                        <span v-for="builtin in roleItem.builtIn" :key="builtin">
                          {{ builtin.replace(/^eevee\./, "") }}
                        </span>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
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
              <h2>{{ t("MCP 与扩展") }}</h2>
              <button type="button" class="btn sm" :disabled="reloadingMcp.busy.value" @click="reloadMcp">
                <Icon name="refresh" size="xs" :spin="reloadingMcp.busy.value" />
                <span>{{ t("重新加载") }}</span>
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
                  <strong>{{ t("{n} 个问题", { n: capabilities.problems.length }) }}</strong>
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
                <h3 title="~/.eevee/mcp.json">{{ t("MCP 服务器") }}</h3>
                <span class="spacer" />
                <a class="btn sm" :href="NEW_SERVER">
                  <Icon name="plus" size="xs" />
                  <span>{{ t("添加") }}</span>
                </a>
              </div>
              <p v-if="togglingServer.error.value" class="error hint">{{ togglingServer.error.value }}</p>
              <div class="rows">
                <div v-if="capabilities.mcp.length === 0" class="row">
                  <span class="muted">{{ t("没有 MCP 服务器") }}</span>
                </div>
                <div v-for="server in capabilities.mcp" :key="server.name" class="row has-link">
                  <a class="r-main row-link" :href="serverHref(server.name)">
                    <span class="r-t">
                      <span class="mono">mcp.{{ server.name }}</span>
                      <span class="chip mono" :title="t('工具提供方式')">{{ server.exposure }}</span>
                    </span>
                    <span class="r-d">
                      {{ t("{n} 个工具", { n: server.tools }) }}
                      <template v-if="rolesUsingExtension(`mcp.${server.name}`).length > 0">
                        · {{ rolesUsingExtension(`mcp.${server.name}`).join(t("、")) }}
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
                    :aria-label="t('启用 {name}', { name: server.name })"
                    @click="toggleServer(server.name)"
                  />
                </div>
              </div>
              <div class="section-t"><h3 title="~/.eevee/extensions/">{{ t("用户扩展") }}</h3></div>
              <div class="rows">
                <div v-if="capabilities.userExtensions.length === 0" class="row">
                  <span class="muted">{{ t("没有用户扩展") }}</span>
                </div>
                <div v-for="ext in capabilities.userExtensions" :key="ext.file" class="row">
                  <div class="r-main">
                    <span class="r-t"><span class="mono">{{ ext.file }}</span></span>
                    <span class="r-d">{{ ext.name ? `${ext.name} · ${t("{n} 个工具", { n: ext.tools })}` : t("未加载") }}</span>
                    <span v-if="ext.error" class="err">{{ configIssueText(ext.error) }}</span>
                  </div>
                  <span class="status-text">
                    <span class="dot" :class="ext.error ? 'bad' : 'ok'" />
                    <span>{{ ext.error ? t("加载失败") : t("已加载") }}</span>
                  </span>
                </div>
              </div>
            </template>
          </template>

          <template v-else-if="section === 'engine'">
            <header class="set-head"><h2>Engine</h2></header>
            <div class="rows">
              <div class="row">
                <div class="r-main"><span class="r-t">{{ t("状态") }}</span></div>
                <span class="status-text">
                  <span class="dot" :class="streamBadge.dot" />
                  <span>{{ streamBadge.label }}</span>
                </span>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">{{ t("版本") }}</span></div>
                <span class="value">{{ status?.version ?? "—" }}</span>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">{{ t("地址") }}</span></div>
                <span class="value">{{ status ? `http://127.0.0.1:${status.port}/` : "—" }}</span>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">bootId</span></div>
                <span class="value">{{ status?.bootId ?? "—" }}</span>
              </div>
            </div>
            <div class="section-t"><h3>{{ t("重启") }}</h3></div>
            <div class="codeline">
              <code>{{ RESTART }}</code>
              <button type="button" class="btn ghost sm icon" :aria-label="t('复制重启命令')" @click="copyText(RESTART)">
                <Icon name="copy" size="xs" />
              </button>
            </div>
            <p class="hint">{{ t("会终止正在运行的后台作业") }}</p>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
