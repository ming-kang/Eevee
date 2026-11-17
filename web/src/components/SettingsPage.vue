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
import type { StreamState } from "../stream.ts";
import { useSubmit } from "../submit.ts";
import { useTheme } from "../theme.ts";
import { showToast } from "../toasts.ts";
import Icon from "./Icon.vue";
import MarkdownText from "./MarkdownText.vue";

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

const MODEL_ROLES: { key: "default" | RoleName; label: string; desc: string }[] = [
  { key: "default", label: "全局默认", desc: "没有单独设置的角色都用它" },
  { key: "router", label: "Router", desc: "规划与调度；快、缓存命中高的模型更合适" },
  { key: "worker", label: "Worker", desc: "执行工单；Router 可以按工单另选模型" },
  { key: "dreamer", label: "Dreamer", desc: "整理记忆；轻量模型即可" },
];

const ROLE_META: Record<RoleName, { label: string; desc: string }> = {
  router: { label: "Router", desc: "主对话与调度" },
  worker: { label: "Worker", desc: "工单执行" },
  dreamer: { label: "Dreamer", desc: "记忆整理" },
};

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
    showToast(`已更新 ${ROLE_META[role].label} 轮次上限`);
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
    .map((r) => ROLE_META[r.role].label);
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
  if (props.streamState === "connected") return { dot: "ok", label: "运行中 · 实时流已连接" };
  if (props.streamState === "connecting") return { dot: "run", label: "运行中 · 正在连接实时流" };
  if (props.streamState === "reconnecting") return { dot: "run", label: "实时流重连中" };
  return { dot: "bad", label: "实时流已断开" };
});
</script>

<template>
  <section class="page-wrap">
    <header class="header">
      <button type="button" class="btn ghost icon menu-btn" title="菜单" aria-label="菜单" @click="$emit('open-side')">
        <Icon name="menu" />
      </button>
      <h1>设置</h1>
      <span class="muted hide-sm" style="font-size: 12px">对全部项目生效</span>
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
          <span>{{ item.label }}</span>
          <span
            v-if="item.key === 'mcp' && (capabilities?.problems.length ?? 0) > 0"
            class="dot bad"
            style="margin-left: auto"
            title="存在连接或扩展加载问题"
            aria-hidden="true"
          />
          <span
            v-if="item.key === 'mcp' && (capabilities?.problems.length ?? 0) > 0"
            class="sr"
          >
            （存在连接或扩展加载问题）
          </span>
        </a>
      </nav>

      <div class="set-body">
        <div class="set-inner">
          <template v-if="section === 'models'">
            <header>
              <h2>模型</h2>
              <p>按角色选择默认模型。改动立即应用到全部项目的 Router 和没有指定模型的工单。</p>
            </header>

            <p v-if="modelsError" class="error hint">{{ modelsError }}</p>
            <p v-else-if="loadingModels && modelsView === undefined" class="hint">
              正在加载模型配置…
            </p>
            <template v-else-if="modelsView">
              <div v-if="modelsView.problems.length > 0" class="banner bad">
                <Icon name="alert" size="sm" />
                <div>
                  <strong>models.json 存在配置问题（受影响的 provider 保持内置设置）：</strong>
                  <ul>
                    <li v-for="(prob, idx) in modelsView.problems" :key="idx">{{ prob }}</li>
                  </ul>
                </div>
              </div>

              <p v-if="savingModel.error.value" class="error hint">{{ savingModel.error.value }}</p>
              <div class="rows">
                <div
                  v-for="roleRow in MODEL_ROLES"
                  :key="roleRow.key"
                  class="row model-row-ctrl"
                  style="position: relative"
                >
                  <div class="r-main">
                    <span class="r-t">
                      {{ roleRow.label }}
                      <span
                        v-if="roleRow.key === 'router' && modelsView.routerModel"
                        class="chip mono"
                        style="margin-left: 6px; font-weight: 400"
                        title="Router 当前实际使用的模型"
                      >
                        生效 {{ modelsView.routerModel.provider }}/{{ modelsView.routerModel.modelId }}
                      </span>
                    </span>
                    <span class="r-d">{{ roleRow.desc }}</span>
                  </div>
                  <button
                    type="button"
                    class="model-pick"
                    :class="{ inherit: modelLabel(roleRow.key).inherited }"
                    :disabled="availableModels.length === 0 || savingModel.busy.value"
                    @click="toggleModelPop(roleRow.key)"
                  >
                    <Icon v-if="!modelLabel(roleRow.key).inherited" name="cpu" size="xs" />
                    <span class="ellipsis" style="flex: 1; text-align: left">
                      {{ modelLabel(roleRow.key).text }}
                    </span>
                    <Icon name="chevD" size="xs" />
                  </button>

                  <div
                    v-if="popRole === roleRow.key"
                    class="pop"
                    style="top: 50px; right: 16px; width: min(360px, calc(100vw - 40px)); max-height: 360px; overflow-y: auto"
                  >
                    <div class="palette-in" style="height: 40px; padding: 0 8px; margin: -6px -6px 6px">
                      <Icon name="search" size="sm" />
                      <input
                        v-model="popSearch"
                        placeholder="搜索模型…"
                        style="font-size: 13px"
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
                          :class="{ sel: modelLabel(roleRow.key).text === `${entry.provider}/${entry.modelId}` }"
                          @click="pickRoleModel(roleRow.key, entry)"
                        >
                          <span class="mono ellipsis" style="flex: 1; font-size: 12px">
                            {{ entry.modelId }}
                          </span>
                          <span class="dim" style="font-size: 11px">
                            {{ entry.name }} · {{ compactTokens(entry.contextWindow) }}
                          </span>
                          <Icon
                            v-if="!modelLabel(roleRow.key).inherited && modelLabel(roleRow.key).text === `${entry.provider}/${entry.modelId}`"
                            name="check"
                            size="sm"
                          />
                        </button>
                      </template>
                    </template>
                    <div v-else class="hint" style="padding: 12px; text-align: center">
                      没有匹配的可用模型
                    </div>
                  </div>
                </div>
              </div>

              <div class="section-t">
                <h3>凭据与 Provider</h3>
                <span class="muted" style="font-size: 12px">
                  已配置 {{ configuredProviders.length }} / {{ modelsView.providers.length }}
                </span>
                <span class="spacer" />
                <button
                  v-if="configuredProviders.length > 0 && unconfiguredProviders.length > 0"
                  type="button"
                  class="btn sm ghost"
                  @click="showAllProviders = !showAllProviders"
                >
                  {{ showAllProviders ? "仅看已配置" : `显示全部（含 ${unconfiguredProviders.length} 个未配置）` }}
                </button>
              </div>

              <div class="rows">
                <div v-for="prov in visibleProviders" :key="prov.id" class="row">
                  <div class="r-main">
                    <span class="r-t" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                      <span class="dot" :class="{ ok: prov.configured }" />
                      <span>{{ prov.name }}</span>
                      <span v-if="prov.name !== prov.id" class="mono muted" style="font-size: 11px">
                        {{ prov.id }}
                      </span>
                      <span v-if="prov.custom" class="chip">自定义</span>
                    </span>
                    <span class="r-d">
                      {{ prov.modelCount }} 个模型
                      <template v-if="prov.configured">
                        · 凭据来源：{{ prov.source || (prov.authType === "oauth" ? "OAuth" : "已配置") }}
                      </template>
                      <template v-else> · 未配置凭据</template>
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
                    :title="`eevee model login ${prov.id}`"
                    @click="copyText(`eevee model login ${prov.id}`)"
                  >
                    <Icon name="copy" size="xs" />
                    <span>复制登录命令</span>
                  </button>
                </div>
              </div>

              <div class="section-t">
                <h3>可用模型目录</h3>
                <span class="spacer" />
                <span class="hint">登录请在终端运行 <span class="mono">eevee model login &lt;provider&gt;</span></span>
              </div>

              <div v-if="availableModels.length > 0" class="panel" style="overflow-x: auto">
                <table class="table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>名称</th>
                      <th>上下文</th>
                      <th class="hide-sm">定价与特性</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="entry in availableModels" :key="`${entry.provider}/${entry.modelId}`">
                      <td class="mono" style="font-size: 12px">{{ entry.provider }}/{{ entry.modelId }}</td>
                      <td>{{ entry.name }}</td>
                      <td class="num muted">{{ compactTokens(entry.contextWindow) }}</td>
                      <td class="hide-sm muted">{{ formatModelMeta(entry) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else class="banner info">
                <Icon name="key" size="sm" />
                <span>
                  当前没有已配置凭据的模型 provider。请在终端运行
                  <span class="mono">eevee model login &lt;provider&gt;</span>，或配置环境变量后重启 Engine。
                </span>
              </div>

              <template v-if="modelsView.profiles">
                <div class="section-t">
                  <h3>使用经验（~/.eevee/models.md）</h3>
                </div>
                <div class="panel">
                  <div class="panel-b">
                    <MarkdownText :source="modelsView.profiles" />
                  </div>
                </div>
              </template>
            </template>
          </template>

          <template v-else-if="section === 'roles'">
            <header>
              <h2>角色能力</h2>
              <p>按角色启用扩展。Worker 工单共享 Worker 的配置；改动立即应用到 Router 和全部未结工单。</p>
            </header>

            <p v-if="capError || savingRole.error.value" class="error hint">
              {{ capError ?? savingRole.error.value }}
            </p>
            <p v-else-if="loadingCap && !capabilities" class="hint">正在加载角色能力…</p>
            <template v-else-if="capabilities">
              <div class="panel" style="overflow-x: auto">
                <table class="matrix">
                  <thead>
                    <tr>
                      <th>扩展</th>
                      <th v-for="roleItem in capabilities.roles" :key="roleItem.role">
                        <span class="rl">{{ ROLE_META[roleItem.role].label }}</span>
                        <span>{{ ROLE_META[roleItem.role].desc }}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-if="capabilities.available.length === 0">
                      <td colspan="4" class="muted" style="text-align: center; padding: 18px">
                        还没有可选扩展（在 MCP 与扩展页面查看安装状态）。
                      </td>
                    </tr>
                    <tr v-for="ext in capabilities.available" :key="ext.name">
                      <td>
                        <div class="ext">
                          <b style="display: flex; gap: 6px; align-items: center">
                            <Icon :name="ext.name.startsWith('mcp.') ? 'plug' : 'puzzle'" size="xs" />
                            <span>{{ ext.name }}</span>
                            <span
                              v-if="mcpFailed(ext.name)"
                              class="dot bad"
                              title="MCP 服务器连接失败"
                            />
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
                          :title="`${ROLE_META[roleItem.role].label} · ${ext.name}`"
                          :aria-label="`${ROLE_META[roleItem.role].label} 启用 ${ext.name}`"
                          :aria-pressed="roleItem.enabled.includes(ext.name)"
                          @click="toggleExtension(roleItem.role, ext.name)"
                        />
                      </td>
                    </tr>

                    <tr>
                      <td>
                        <div class="ext">
                          <b>每轮轮次上限</b>
                          <span>maxTurns · 留空用默认值</span>
                        </div>
                      </td>
                      <td v-for="roleItem in capabilities.roles" :key="roleItem.role">
                        <input
                          v-model="turnDrafts[roleItem.role]"
                          class="input mono"
                          style="width: 72px; height: 28px; text-align: center"
                          placeholder="默认"
                          :disabled="savingRole.busy.value"
                          @change="commitMaxTurns(roleItem.role)"
                        />
                      </td>
                    </tr>

                    <tr class="builtin">
                      <td style="vertical-align: top">
                        <div class="ext">
                          <b style="display: flex; gap: 6px; align-items: center">
                            <Icon name="lock" size="xs" />
                            <span>自带扩展</span>
                          </b>
                          <span>角色的基础能力，始终启用（共 {{ builtInCount }} 个）</span>
                        </div>
                      </td>
                      <td
                        v-for="roleItem in capabilities.roles"
                        :key="roleItem.role"
                        style="vertical-align: top"
                      >
                        <div style="display: flex; flex-direction: column; gap: 3px; align-items: center">
                          <span
                            v-for="builtin in roleItem.builtIn"
                            :key="builtin"
                            class="mono dim"
                            style="font-size: 11px"
                          >
                            {{ builtin.replace(/^eevee\./, "") }}
                          </span>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="hint">
                也可以在终端用 <span class="mono">eevee role enable worker &lt;扩展名&gt;</span>
                修改，保存在 <span class="mono">settings.json</span>。
              </p>
            </template>
          </template>

          <template v-else-if="section === 'mcp'">
            <header style="display: flex; align-items: flex-end; gap: 12px">
              <div style="flex: 1">
                <h2>MCP 与扩展</h2>
                <p>
                  MCP 服务器来自 <span class="mono">~/.eevee/mcp.json</span>，用户扩展来自
                  <span class="mono">~/.eevee/extensions/</span>。在“角色能力”里决定哪些角色启用它们。
                </p>
              </div>
              <button
                type="button"
                class="btn sm"
                :disabled="reloadingMcp.busy.value"
                @click="reloadMcp"
              >
                <Icon name="refresh" size="xs" :spin="reloadingMcp.busy.value" />
                <span>重新加载</span>
              </button>
            </header>

            <p v-if="capError || reloadingMcp.error.value" class="error hint">
              {{ capError ?? reloadingMcp.error.value }}
            </p>
            <p v-else-if="loadingCap && !capabilities" class="hint">正在加载扩展信息…</p>
            <template v-else-if="capabilities">
              <div v-if="capabilities.problems.length > 0" class="banner bad">
                <Icon name="alert" size="sm" />
                <div>
                  <b style="font-weight: 600">{{ capabilities.problems.length }} 个问题</b>
                  <ul>
                    <li v-for="(prob, idx) in capabilities.problems" :key="idx">{{ prob }}</li>
                  </ul>
                </div>
              </div>

              <div class="section-t"><h3>MCP 服务器</h3></div>
              <div class="rows">
                <div v-if="capabilities.mcp.length === 0" class="row" style="min-height: 48px">
                  <span class="hint">还没有配置 MCP 服务器。</span>
                </div>
                <div v-for="server in capabilities.mcp" :key="server.name" class="row">
                  <div class="r-main">
                    <span class="r-t">
                      <Icon name="plug" size="xs" />
                      <span class="mono">mcp.{{ server.name }}</span>
                      <span
                        class="chip mono"
                        style="height: 18px"
                        title="工具呈现方式（在 mcp.json 中配置）"
                      >
                        {{ server.exposure }}
                      </span>
                    </span>
                    <span class="r-d">
                      {{ server.tools }} 个工具 ·
                      {{
                        rolesUsingExtension(`mcp.${server.name}`).length > 0
                          ? `已为 ${rolesUsingExtension(`mcp.${server.name}`).join("、")} 启用`
                          : "没有角色启用"
                      }}
                    </span>
                    <span v-if="server.error" class="err">{{ server.error }}</span>
                  </div>
                  <span style="display: inline-flex; gap: 6px; align-items: center; font-size: 12px">
                    <span class="dot" :class="MCP_STATE_LABEL[server.state].dot" />
                    <span>{{ MCP_STATE_LABEL[server.state].label }}</span>
                  </span>
                </div>
              </div>

              <div class="section-t"><h3>用户扩展</h3></div>
              <div class="rows">
                <div
                  v-if="capabilities.userExtensions.length === 0"
                  class="row"
                  style="min-height: 48px"
                >
                  <span class="hint">还没有用户扩展（可将 .mjs 放入 ~/.eevee/extensions/）。</span>
                </div>
                <div v-for="ext in capabilities.userExtensions" :key="ext.file" class="row">
                  <div class="r-main">
                    <span class="r-t">
                      <Icon name="puzzle" size="xs" />
                      <span class="mono">{{ ext.file }}</span>
                    </span>
                    <span class="r-d">
                      {{ ext.name ? `${ext.name} · ${ext.tools} 个工具` : "未加载" }}
                    </span>
                    <span v-if="ext.error" class="err">{{ ext.error }}</span>
                  </div>
                  <span style="display: inline-flex; gap: 6px; align-items: center; font-size: 12px">
                    <span class="dot" :class="ext.error ? 'bad' : 'ok'" />
                    <span>{{ ext.error ? "加载失败" : "已加载" }}</span>
                  </span>
                </div>
              </div>
            </template>
          </template>

          <template v-else-if="section === 'engine'">
            <header>
              <h2>Engine</h2>
              <p>常驻后台的进程，承载全部项目和这个面板。</p>
            </header>

            <div class="rows">
              <div class="row">
                <div class="r-main">
                  <span class="r-t">界面主题</span>
                  <span class="r-d">默认跟随系统配色，可单独固定浅色或深色</span>
                </div>
                <div class="seg" role="group" aria-label="界面主题">
                  <button
                    type="button"
                    :class="{ on: themePref === 'system' }"
                    :aria-pressed="themePref === 'system'"
                    @click="setTheme('system')"
                  >
                    跟随系统
                  </button>
                  <button
                    type="button"
                    :class="{ on: themePref === 'light' }"
                    :aria-pressed="themePref === 'light'"
                    @click="setTheme('light')"
                  >
                    浅色
                  </button>
                  <button
                    type="button"
                    :class="{ on: themePref === 'dark' }"
                    :aria-pressed="themePref === 'dark'"
                    @click="setTheme('dark')"
                  >
                    深色
                  </button>
                </div>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">状态</span></div>
                <span style="display: inline-flex; gap: 6px; align-items: center; font-size: 13px">
                  <span class="dot" :class="streamBadge.dot" />
                  <span>{{ streamBadge.label }}</span>
                </span>
              </div>
              <div class="row">
                <div class="r-main"><span class="r-t">版本</span></div>
                <span class="mono muted">{{ status?.version ?? "—" }}</span>
              </div>
              <div class="row">
                <div class="r-main">
                  <span class="r-t">地址</span>
                  <span class="r-d">只监听本机</span>
                </div>
                <span class="mono muted">
                  {{ status ? `http://127.0.0.1:${status.port}/` : "—" }}
                </span>
              </div>
              <div class="row">
                <div class="r-main">
                  <span class="r-t">bootId</span>
                  <span class="r-d">Engine 每次启动都会变化；面板发现变化时会重新订阅全部数据</span>
                </div>
                <span class="mono muted">{{ status?.bootId ?? "—" }}</span>
              </div>
              <div class="row">
                <div class="r-main">
                  <span class="r-t">数据目录</span>
                  <span class="r-d">默认是 ~/.eevee/，设置了 EEVEE_HOME 时在那里</span>
                </div>
              </div>
            </div>

            <div class="section-t"><h3>停止或重启</h3></div>
            <div class="rows">
              <div class="row">
                <div class="r-main">
                  <span class="r-t">在终端运行</span>
                  <span class="r-d">
                    停止会终止正在运行的后台作业；重启后相关 Worker 会收到通知，自行决定是否重跑。
                  </span>
                  <div class="codeline" style="margin-top: 6px">
                    <code>eevee stop && eevee start</code>
                    <button
                      type="button"
                      class="btn ghost sm icon"
                      title="复制命令"
                      aria-label="复制重启命令"
                      @click="copyText('eevee stop && eevee start')"
                    >
                      <Icon name="copy" size="xs" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
