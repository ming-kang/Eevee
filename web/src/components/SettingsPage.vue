<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type {
  CapabilitiesView,
  EngineStatus,
  McpServerView,
  ModelSpecView,
  ModelsView,
} from "@shared/api/contract.ts";
import type { ModelDefaults, RoleName } from "@shared/contracts/index.ts";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { SettingsSection } from "../router.ts";
import { vSeg } from "../dom.ts";
import type { StreamState } from "../stream.ts";
import { useSubmit } from "../submit.ts";
import { TEXT_SIZES } from "../text-size.ts";
import { type ThemePreference, useTextSize, useTheme } from "../theme.ts";
import { showToast } from "../toasts.ts";
import Icon from "./Icon.vue";
import MarkdownText from "./MarkdownText.vue";
import Skeleton from "./Skeleton.vue";

const props = defineProps<{
  client: Client;
  section: SettingsSection;
  status: EngineStatus | undefined;
  streamState: StreamState;
  refreshStatus: () => Promise<void>;
}>();

defineEmits<{
  "open-side": [];
}>();

const { preference: themePref, setTheme } = useTheme();
const { size: textSize, setTextSize } = useTextSize();

const modelsView = ref<ModelsView>();
const modelsError = ref<string>();
const loadingModels = ref(false);
const popRole = ref<"default" | RoleName>();
const popSearch = ref("");
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
  { key: "default", label: "全局默认" },
  { key: "router", label: "Router" },
  { key: "worker", label: "Worker" },
  { key: "dreamer", label: "Dreamer" },
];

const ROLE_LABEL: Record<RoleName, string> = {
  router: "Router",
  worker: "Worker",
  dreamer: "Dreamer",
};

const THEME_OPTIONS: { key: ThemePreference; label: string }[] = [
  { key: "system", label: "跟随系统" },
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
];

const RESTART = "eevee stop && eevee start";

const loginCommand = (provider: string) => `eevee model login ${provider}`;

const MCP_STATE_LABEL: Record<McpServerView["state"], { dot: string; label: string }> = {
  connected: { dot: "ok", label: "已连接" },
  connecting: { dot: "run", label: "连接中" },
  failed: { dot: "bad", label: "失败" },
  disabled: { dot: "", label: "已停用" },
};

const SECTIONS: { key: SettingsSection; label: string; icon: "cpu" | "puzzle" | "plug" | "server" }[] = [
  { key: "models", label: "模型", icon: "cpu" },
  { key: "roles", label: "角色能力", icon: "puzzle" },
  { key: "mcp", label: "MCP 与扩展", icon: "plug" },
  { key: "engine", label: "Engine", icon: "server" },
];

function syncTurnDrafts(cap: CapabilitiesView): void {
  const next: Record<RoleName, string> = { router: "", worker: "", dreamer: "" };
  for (const r of cap.roles) {
    next[r.role] = r.maxTurns !== undefined ? String(r.maxTurns) : "";
  }
  turnDrafts.value = next;
}

async function loadModels(): Promise<void> {
  loadingModels.value = true;
  modelsError.value = undefined;
  try {
    modelsView.value = await props.client.call("GET /api/models");
  } catch (err) {
    modelsError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingModels.value = false;
  }
}

async function loadCapabilities(): Promise<void> {
  loadingCap.value = true;
  capError.value = undefined;
  try {
    const view = await props.client.call("GET /api/capabilities");
    capabilities.value = view;
    syncTurnDrafts(view);
  } catch (err) {
    capError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingCap.value = false;
  }
}

watch(
  () => props.section,
  (sec) => {
    popRole.value = undefined;
    if (sec === "models" && modelsView.value === undefined) void loadModels();
    if (!capabilities.value) void loadCapabilities();
  },
  { immediate: true },
);

function onWindowClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target?.closest(".model-row-ctrl")) {
    popRole.value = undefined;
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

const filteredCatalogByProvider = computed(() => {
  const q = popSearch.value.trim().toLowerCase();
  const groups = new Map<string, ModelSpecView[]>();
  for (const item of availableModels.value) {
    const fullId = `${item.provider}/${item.modelId}`;
    if (q && !`${fullId} ${item.name}`.toLowerCase().includes(q)) continue;
    const list = groups.get(item.provider) ?? [];
    list.push(item);
    groups.set(item.provider, list);
  }
  return [...groups.entries()];
});

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function formatCacheDuration(seconds: number): string {
  return seconds >= 3600 ? `${+(seconds / 3600).toFixed(1)} 小时` : `${Math.round(seconds / 60)} 分钟`;
}

function formatModelMeta(model: ModelSpecView): string {
  const parts: string[] = [];
  if (model.cost.input || model.cost.output) {
    parts.push(`输入 $${model.cost.input}/M`, `输出 $${model.cost.output}/M`);
  }
  if (model.cost.cacheRead) parts.push(`缓存读 $${model.cost.cacheRead}/M`);
  if (model.cacheShortSeconds) parts.push(`缓存 ${formatCacheDuration(model.cacheShortSeconds)}`);
  if (model.reasoning) parts.push("推理");
  return parts.join(" · ") || "—";
}

function toggleModelPop(roleKey: "default" | RoleName): void {
  if (popRole.value === roleKey) {
    popRole.value = undefined;
    return;
  }
  popSearch.value = "";
  popRole.value = roleKey;
}

function modelLabel(roleKey: keyof ModelDefaults): { text: string; inherited: boolean } {
  const defaults = modelsView.value?.defaults;
  const own = defaults?.[roleKey];
  if (own) return { text: `${own.provider}/${own.modelId}`, inherited: false };
  const effective = roleKey === "router" ? modelsView.value?.routerModel : defaults?.default;
  if (roleKey !== "default" && effective) {
    return { text: `跟随默认 · ${effective.provider}/${effective.modelId}`, inherited: true };
  }
  return { text: "未设置", inherited: true };
}

/** Whether Router actually runs on a model other than the one its row shows. */
const routerDiffers = computed(() => {
  const effective = modelsView.value?.routerModel;
  if (!effective) return false;
  return !modelLabel("router").text.endsWith(`${effective.provider}/${effective.modelId}`);
});

function isPicked(roleKey: keyof ModelDefaults, entry: ModelSpecView): boolean {
  const label = modelLabel(roleKey);
  return !label.inherited && label.text === `${entry.provider}/${entry.modelId}`;
}

async function pickRoleModel(roleKey: "default" | RoleName, choice: ModelSpecView): Promise<void> {
  const fullId = `${choice.provider}/${choice.modelId}`;
  const ok = await savingModel.run(async () => {
    await props.client.call("POST /api/settings/models", {
      ...(roleKey === "default" ? {} : { role: roleKey }),
      provider: choice.provider,
      modelId: choice.modelId,
    });
  });
  if (ok) {
    popRole.value = undefined;
    showToast(`已将 ${MODEL_ROLES.find((r) => r.key === roleKey)?.label ?? roleKey} 模型设为 ${fullId}`);
    await loadModels();
    await props.refreshStatus();
  }
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
    showToast("轮次上限应为正整数，或留空恢复默认", "error");
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
    showToast(`已更新 ${ROLE_LABEL[role]} 轮次上限`);
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
    showToast("已重新加载 MCP 与用户扩展");
  }
}

function copyText(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => undefined);
  showToast(`已复制 ${text}`);
}

const streamBadge = computed(() => {
  if (props.streamState === "connected") return { dot: "ok", label: "运行中" };
  if (props.streamState === "connecting") return { dot: "run", label: "正在连接实时流" };
  if (props.streamState === "reconnecting") return { dot: "run", label: "实时流重连中" };
  return { dot: "bad", label: "实时流已断开" };
});
</script>

<template>
  <section class="page-wrap">
    <header class="header">
      <button type="button" class="btn ghost sm icon menu-btn" aria-label="菜单" @click="$emit('open-side')">
        <Icon name="menu" size="sm" />
      </button>
      <h1>设置</h1>
    </header>
    <div class="settings">
      <nav class="set-nav" aria-label="设置分类">
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
            title="存在连接或扩展加载问题"
          />
          <span v-if="item.key === 'mcp' && (capabilities?.problems.length ?? 0) > 0" class="sr">
            （存在连接或扩展加载问题）
          </span>
        </a>
      </nav>

      <div class="set-body">
        <div class="set-inner">
          <template v-if="section === 'models'">
            <header class="set-head"><h2>模型</h2></header>
            <p v-if="modelsError" class="error hint">{{ modelsError }}</p>
            <Skeleton v-else-if="loadingModels && modelsView === undefined" />
            <template v-else-if="modelsView">
              <div v-if="modelsView.problems.length > 0" class="banner bad">
                <Icon name="alert" size="sm" />
                <div>
                  <strong>models.json 有问题，相关 provider 沿用内置设置</strong>
                  <ul>
                    <li v-for="(prob, idx) in modelsView.problems" :key="idx">{{ prob }}</li>
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
                        title="Router 当前实际使用的模型"
                      >
                        生效 {{ modelsView.routerModel?.provider }}/{{ modelsView.routerModel?.modelId }}
                      </span>
                    </span>
                  </div>
                  <button
                    type="button"
                    class="model-pick"
                    :class="{ inherit: modelLabel(roleRow.key).inherited }"
                    :disabled="availableModels.length === 0 || savingModel.busy.value"
                    :aria-expanded="popRole === roleRow.key"
                    @click="toggleModelPop(roleRow.key)"
                  >
                    <span class="ellipsis spacer">{{ modelLabel(roleRow.key).text }}</span>
                    <Icon name="chevD" size="xs" />
                  </button>
                  <div v-if="popRole === roleRow.key" class="pop model-pop">
                    <div class="pop-search">
                      <Icon name="search" size="sm" />
                      <input
                        v-model="popSearch"
                        placeholder="搜索模型…"
                        aria-label="搜索模型"
                        @keydown.esc.prevent="popRole = undefined"
                      />
                    </div>
                    <template v-if="filteredCatalogByProvider.length > 0">
                      <template v-for="[provider, entries] in filteredCatalogByProvider" :key="provider">
                        <div class="palette-g">{{ provider }}</div>
                        <button
                          v-for="entry in entries"
                          :key="`${entry.provider}/${entry.modelId}`"
                          type="button"
                          class="pop-row"
                          @click="pickRoleModel(roleRow.key, entry)"
                        >
                          <span class="mono">{{ entry.modelId }}</span>
                          <span class="meta">{{ compactTokens(entry.contextWindow) }}</span>
                          <Icon
                            v-if="isPicked(roleRow.key, entry)"
                            name="check"
                            size="sm"
                          />
                        </button>
                      </template>
                    </template>
                    <div v-else class="palette-empty">没有结果</div>
                  </div>
                </div>
              </div>

              <div class="section-t">
                <h3>Provider</h3>
                <span class="count">{{ configuredProviders.length }}/{{ modelsView.providers.length }}</span>
                <span class="spacer" />
                <button
                  v-if="configuredProviders.length > 0 && unconfiguredProviders.length > 0"
                  type="button"
                  class="btn sm ghost"
                  @click="showAllProviders = !showAllProviders"
                >
                  {{ showAllProviders ? "仅已配置" : "显示全部" }}
                </button>
              </div>
              <div class="rows">
                <div v-for="prov in visibleProviders" :key="prov.id" class="row">
                  <span class="dot" :class="{ ok: prov.configured }" />
                  <div class="r-main">
                    <span class="r-t">
                      <span>{{ prov.name }}</span>
                      <span v-if="prov.custom" class="chip">自定义</span>
                    </span>
                    <span class="r-d">
                      <span v-if="prov.name !== prov.id" class="mono">{{ prov.id }} · </span>
                      {{ prov.modelCount }} 个模型
                      <template v-if="prov.configured && prov.source"> · {{ prov.source }}</template>
                    </span>
                  </div>
                  <span v-if="prov.configured" class="chip">
                    <Icon name="key" size="xs" />
                    <span>{{ prov.authType === "oauth" ? "OAuth" : "API Key" }}</span>
                  </span>
                  <button
                    v-else
                    type="button"
                    class="btn sm"
                    :title="loginCommand(prov.id)"
                    @click="copyText(loginCommand(prov.id))"
                  >
                    <Icon name="copy" size="xs" />
                    <span>登录命令</span>
                  </button>
                </div>
              </div>

              <div class="section-t"><h3>可用模型</h3></div>
              <div v-if="availableModels.length > 0" class="panel">
                <table class="table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>名称</th>
                      <th>上下文</th>
                      <th class="hide-sm">定价</th>
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
              <div v-else class="codeline">
                <code>{{ loginCommand("<provider>") }}</code>
                <button
                  type="button"
                  class="btn ghost sm icon"
                  aria-label="复制登录命令"
                  @click="copyText(loginCommand('<provider>'))"
                >
                  <Icon name="copy" size="xs" />
                </button>
              </div>

              <template v-if="modelsView.profiles">
                <div class="section-t"><h3 title="~/.eevee/models.md">使用经验</h3></div>
                <div class="panel">
                  <div class="panel-b msg-ai">
                    <MarkdownText :source="modelsView.profiles" />
                  </div>
                </div>
              </template>
            </template>
          </template>

          <template v-else-if="section === 'roles'">
            <header class="set-head"><h2>角色能力</h2></header>
            <p v-if="capError || savingRole.error.value" class="error hint">
              {{ capError ?? savingRole.error.value }}
            </p>
            <Skeleton v-else-if="loadingCap && !capabilities" />
            <div v-else-if="capabilities" class="panel">
              <table class="matrix">
                <thead>
                  <tr>
                    <th>扩展</th>
                    <th v-for="roleItem in capabilities.roles" :key="roleItem.role">
                      {{ ROLE_LABEL[roleItem.role] }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="capabilities.available.length === 0">
                    <td colspan="4" class="muted">没有可选扩展</td>
                  </tr>
                  <tr v-for="ext in capabilities.available" :key="ext.name">
                    <td>
                      <div class="ext">
                        <b>
                          <Icon :name="ext.name.startsWith('mcp.') ? 'plug' : 'puzzle'" size="xs" />
                          <span>{{ ext.name }}</span>
                          <span v-if="mcpFailed(ext.name)" class="dot bad" title="MCP 服务器连接失败" />
                        </b>
                        <span>{{ ext.tools }} 个工具</span>
                      </div>
                    </td>
                    <td v-for="roleItem in capabilities.roles" :key="roleItem.role">
                      <button
                        type="button"
                        class="switch"
                        :class="{ on: roleItem.enabled.includes(ext.name) }"
                        :disabled="savingRole.busy.value"
                        :aria-label="`${ROLE_LABEL[roleItem.role]} 启用 ${ext.name}`"
                        :aria-pressed="roleItem.enabled.includes(ext.name)"
                        @click="toggleExtension(roleItem.role, ext.name)"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <div class="ext" title="settings.json 中的 roles.<角色>.maxTurns">
                        <b>轮次上限</b>
                      </div>
                    </td>
                    <td v-for="roleItem in capabilities.roles" :key="roleItem.role">
                      <input
                        v-model="turnDrafts[roleItem.role]"
                        class="input mono"
                        placeholder="默认"
                        :aria-label="`${ROLE_LABEL[roleItem.role]} 轮次上限`"
                        :disabled="savingRole.busy.value"
                        @change="commitMaxTurns(roleItem.role)"
                      />
                    </td>
                  </tr>
                  <tr class="builtin">
                    <td>
                      <div class="ext" title="始终启用">
                        <b>
                          <Icon name="lock" size="xs" />
                          <span>自带扩展</span>
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

          <template v-else-if="section === 'mcp'">
            <header class="set-head">
              <h2>MCP 与扩展</h2>
              <button type="button" class="btn sm" :disabled="reloadingMcp.busy.value" @click="reloadMcp">
                <Icon name="refresh" size="xs" :spin="reloadingMcp.busy.value" />
                <span>重新加载</span>
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
                  <strong>{{ capabilities.problems.length }} 个问题</strong>
                  <ul>
                    <li v-for="(prob, idx) in capabilities.problems" :key="idx">{{ prob }}</li>
                  </ul>
                </div>
              </div>
              <div class="section-t"><h3 title="~/.eevee/mcp.json">MCP 服务器</h3></div>
              <div class="rows">
                <div v-if="capabilities.mcp.length === 0" class="row">
                  <span class="muted">没有 MCP 服务器</span>
                </div>
                <div v-for="server in capabilities.mcp" :key="server.name" class="row">
                  <div class="r-main">
                    <span class="r-t">
                      <span class="mono">mcp.{{ server.name }}</span>
                      <span class="chip mono" title="工具呈现方式（在 mcp.json 中配置）">{{ server.exposure }}</span>
                    </span>
                    <span class="r-d">
                      {{ server.tools }} 个工具
                      <template v-if="rolesUsingExtension(`mcp.${server.name}`).length > 0">
                        · {{ rolesUsingExtension(`mcp.${server.name}`).join("、") }}
                      </template>
                    </span>
                    <span v-if="server.error" class="err">{{ server.error }}</span>
                  </div>
                  <span class="status-text">
                    <span class="dot" :class="MCP_STATE_LABEL[server.state].dot" />
                    <span>{{ MCP_STATE_LABEL[server.state].label }}</span>
                  </span>
                </div>
              </div>
              <div class="section-t"><h3 title="~/.eevee/extensions/">用户扩展</h3></div>
              <div class="rows">
                <div v-if="capabilities.userExtensions.length === 0" class="row">
                  <span class="muted">没有用户扩展</span>
                </div>
                <div v-for="ext in capabilities.userExtensions" :key="ext.file" class="row">
                  <div class="r-main">
                    <span class="r-t"><span class="mono">{{ ext.file }}</span></span>
                    <span class="r-d">{{ ext.name ? `${ext.name} · ${ext.tools} 个工具` : "未加载" }}</span>
                    <span v-if="ext.error" class="err">{{ ext.error }}</span>
                  </div>
                  <span class="status-text">
                    <span class="dot" :class="ext.error ? 'bad' : 'ok'" />
                    <span>{{ ext.error ? "加载失败" : "已加载" }}</span>
                  </span>
                </div>
              </div>
            </template>
          </template>

          <template v-else-if="section === 'engine'">
            <header class="set-head"><h2>Engine</h2></header>
            <div class="rows">
              <div class="row">
                <div class="r-main"><span class="r-t">主题</span></div>
                <div v-seg class="seg sm" role="group" aria-label="界面主题">
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
                <div class="r-main"><span class="r-t">字号</span></div>
                <div v-seg class="seg sm" role="group" aria-label="界面字号">
                  <button
                    v-for="option in TEXT_SIZES"
                    :key="option"
                    type="button"
                    class="num"
                    :class="{ on: textSize === option }"
                    :aria-pressed="textSize === option"
                    @click="setTextSize(option)"
                  >
                    {{ option }}
                  </button>
                </div>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">状态</span></div>
                <span class="status-text">
                  <span class="dot" :class="streamBadge.dot" />
                  <span>{{ streamBadge.label }}</span>
                </span>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">版本</span></div>
                <span class="value">{{ status?.version ?? "—" }}</span>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">地址</span></div>
                <span class="value">{{ status ? `http://127.0.0.1:${status.port}/` : "—" }}</span>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">bootId</span></div>
                <span class="value">{{ status?.bootId ?? "—" }}</span>
              </div>
            </div>
            <div class="section-t"><h3>重启</h3></div>
            <div class="codeline">
              <code>{{ RESTART }}</code>
              <button type="button" class="btn ghost sm icon" aria-label="复制重启命令" @click="copyText(RESTART)">
                <Icon name="copy" size="xs" />
              </button>
            </div>
            <p class="hint">会终止正在运行的后台作业</p>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
