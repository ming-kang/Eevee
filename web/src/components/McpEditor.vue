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
  deferred: { label: t("按需"), detail: t("模型用 tool_search 找到后才能用，适合工具多的服务器") },
  direct: { label: t("直接"), detail: t("和其他工具一样直接提供，适合工具少、常用的服务器") },
  codemode: { label: t("代码模式"), detail: t("只能在 codemode 脚本里调用，适合批量组合调用") },
  hidden: { label: t("隐藏"), detail: t("保持连接，但不提供任何工具") },
};

const STATE_LABEL: Record<string, { dot: string; label: string }> = {
  connected: { dot: "ok", label: t("已连接") },
  connecting: { dot: "run", label: t("连接中") },
  failed: { dot: "bad", label: t("失败") },
  disabled: { dot: "", label: t("已停用") },
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
    formError.value = t("没认出服务器配置：需要带 command 或 url 的 JSON");
    return;
  }
  Object.assign(draft, toMcpDraft(found.config));
  if (found.name !== undefined && newName.value.trim() === "") newName.value = found.name;
  pasting.value = false;
  pasted.value = "";
  formError.value = undefined;
}

function draftErrorText(error: McpDraftError): string {
  if (error.code === "timeout") return t("超时应为正数（秒）");
  return error.field === "command" ? t("请填写命令") : t("请填写 URL");
}

async function save(): Promise<void> {
  formError.value = undefined;
  const name = serverName.value;
  if (isNew.value) {
    if (!isServerName(name)) {
      formError.value = t("名称只能包含字母、数字、_ 和 -");
      return;
    }
    if (entries.value?.[name]) {
      formError.value = t("已经有服务器 {name}", { name });
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
  showToast(t("已保存 {name}", { name }));
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
  showToast(t("已删除 {name}", { name: props.name }));
  location.hash = LIST;
}
</script>

<template>
  <header class="set-head">
    <a class="btn ghost sm icon" :href="LIST" :aria-label="t('返回 MCP 服务器列表')">
      <Icon name="chevL" size="sm" />
    </a>
    <h2 class="ellipsis" :class="{ mono: !isNew }">{{ isNew ? t("添加 MCP 服务器") : name }}</h2>
    <template v-if="!isNew && original">
      <template v-if="confirmRemove">
        <button type="button" class="btn sm danger" :disabled="removing.busy.value" @click="remove">
          {{ t("确认删除") }}
        </button>
        <button type="button" class="btn ghost sm" @click="confirmRemove = false">{{ t("取消") }}</button>
      </template>
      <button
        v-else
        type="button"
        class="btn ghost sm danger"
        :title="roles > 0 ? t('也会从启用它的角色中去掉') : undefined"
        @click="confirmRemove = true"
      >
        <Icon name="x" size="xs" />
        <span>{{ t("删除") }}</span>
      </button>
    </template>
    <button v-if="isNew && !pasting" type="button" class="btn ghost sm" @click="pasting = true">
      <Icon name="copy" size="xs" />
      <span>{{ t("粘贴 JSON") }}</span>
    </button>
  </header>

  <p v-if="loadError" class="error hint">{{ loadError }}</p>
  <p v-else-if="removing.error.value" class="error hint">{{ removing.error.value }}</p>
  <Skeleton v-if="entries === undefined && !loadError" />
  <div v-else-if="missing" class="empty">
    <h3>{{ t("找不到服务器 {name}", { name }) }}</h3>
    <a class="btn sm" :href="LIST">{{ t("返回 MCP 服务器列表") }}</a>
  </div>
  <form v-else-if="entries" class="pv-form" @submit.prevent="save">
    <div v-if="pasting" class="paste">
      <textarea
        v-model="pasted"
        class="input mono"
        rows="6"
        spellcheck="false"
        :aria-label="t('粘贴 JSON')"
        placeholder='{ "mcpServers": { "github": { "command": "github-mcp-server", "args": ["stdio"] } } }'
      />
      <div class="f-inline">
        <span class="spacer" />
        <button type="button" class="btn ghost sm" @click="pasting = false">{{ t("取消") }}</button>
        <button type="button" class="btn sm" :disabled="pasted.trim() === ''" @click="applyPaste">{{ t("填入") }}</button>
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
            {{ t("{n} 个工具", { n: status.tools }) }}
            <template v-if="roles > 0"> · {{ t("{n} 个角色启用", { n: roles }) }}</template>
          </span>
          <span v-if="status.error" class="err">{{ configIssueText(status.error) }}</span>
        </div>
      </div>
      <div v-for="(problem, index) in problems" :key="index" class="row">
        <div class="r-main">
          <span class="r-t"><span class="dot bad" /><span>{{ t("配置有误，没有连接") }}</span></span>
          <span class="err">{{ configIssueText(problem) }}</span>
        </div>
      </div>
    </div>

    <div class="section-t"><h3>{{ t("连接") }}</h3></div>
    <div class="rows">
      <div v-if="isNew" class="f-row">
        <label for="mcp-name">{{ t("名称") }}</label>
        <div class="f-ctrl">
          <input id="mcp-name" v-model="newName" class="input mono" spellcheck="false" autocomplete="off" placeholder="github" />
        </div>
      </div>
      <div class="f-row">
        <span class="f-label">{{ t("传输") }}</span>
        <div v-seg class="seg sm" role="group" :aria-label="t('传输')">
          <button type="button" :class="{ on: draft.transport === 'stdio' }" :aria-pressed="draft.transport === 'stdio'" @click="draft.transport = 'stdio'">
            {{ t("本地命令") }}
          </button>
          <button type="button" :class="{ on: draft.transport === 'http' }" :aria-pressed="draft.transport === 'http'" @click="draft.transport = 'http'">
            HTTP
          </button>
        </div>
      </div>
      <template v-if="draft.transport === 'stdio'">
        <div class="f-row">
          <label for="mcp-command">{{ t("命令") }}</label>
          <div class="f-ctrl">
            <input id="mcp-command" v-model="draft.command" class="input mono" spellcheck="false" autocomplete="off" placeholder="npx" />
          </div>
        </div>
        <div class="f-row top">
          <label for="mcp-args">{{ t("参数") }}</label>
          <div class="f-ctrl">
            <textarea
              id="mcp-args"
              v-model="draft.args"
              class="input mono"
              rows="3"
              spellcheck="false"
              :placeholder="'-y\n@modelcontextprotocol/server-filesystem\n/home/me/papers'"
            />
            <span class="f-note">{{ t("一行一个参数") }}</span>
          </div>
        </div>
        <div class="f-row">
          <label for="mcp-cwd">{{ t("工作目录") }}</label>
          <div class="f-ctrl">
            <input id="mcp-cwd" v-model="draft.cwd" class="input mono" spellcheck="false" autocomplete="off" />
          </div>
        </div>
        <div class="f-row top">
          <span class="f-label">{{ t("环境变量") }}</span>
          <KeyValueRows :rows="draft.env" :label="t('环境变量')" key-placeholder="GITHUB_TOKEN" value-placeholder="${GITHUB_TOKEN}" />
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
          <span class="f-label">{{ t("请求头") }}</span>
          <KeyValueRows :rows="draft.headers" :label="t('请求头')" key-placeholder="Authorization" value-placeholder="Bearer ${TOKEN}" />
        </div>
      </template>
    </div>

    <div class="section-t"><h3>{{ t("工具") }}</h3></div>
    <div class="rows">
      <div class="f-row">
        <span class="f-label">{{ t("启用") }}</span>
        <label class="toggle">
          <button
            type="button"
            class="switch"
            :class="{ on: draft.enabled }"
            :aria-pressed="draft.enabled"
            :aria-label="t('启用')"
            @click="draft.enabled = !draft.enabled"
          />
        </label>
      </div>
      <div class="f-row top">
        <span class="f-label">{{ t("提供方式") }}</span>
        <div class="f-ctrl">
          <div v-seg class="seg sm" role="group" :aria-label="t('提供方式')">
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
        <label for="mcp-desc">{{ t("说明") }}</label>
        <div class="f-ctrl">
          <input id="mcp-desc" v-model="draft.description" class="input" autocomplete="off" :placeholder="t('一句话说明它提供什么')" />
        </div>
      </div>
      <div class="f-row">
        <label for="mcp-timeout">{{ t("超时（秒）") }}</label>
        <div class="f-ctrl">
          <input id="mcp-timeout" v-model="draft.timeout" class="input mono short" inputmode="decimal" autocomplete="off" />
        </div>
      </div>
    </div>

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
