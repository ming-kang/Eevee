<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { ProjectSummary } from "@shared/api/contract.ts";
import { computed, ref, watch } from "vue";
import { trapTab, useFocusReturn } from "../focus.ts";
import { useSubmit } from "../submit.ts";
import { showToast } from "../toasts.ts";
import Icon from "./Icon.vue";

const props = defineProps<{
  open: boolean;
  client: Client;
  onCreated: (project: ProjectSummary) => Promise<void> | void;
}>();

const emit = defineEmits<{
  close: [];
}>();

const title = ref("");
const workspace = ref("");
const localError = ref<string>();
const titleInput = ref<HTMLInputElement>();
const formEl = ref<HTMLFormElement>();
const { busy, error, run } = useSubmit();

useFocusReturn(
  () => props.open,
  () => {
    titleInput.value?.focus();
    return formEl.value;
  },
);

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    title.value = "";
    workspace.value = "";
    localError.value = undefined;
    error.value = undefined;
  },
);

const cliTitle = computed(() => title.value.trim() || "<标题>");
const cliWorkspace = computed(() => workspace.value.trim() || "<目录>");

async function submit(): Promise<void> {
  const t = title.value.trim();
  const w = workspace.value.trim();
  if (!t) {
    localError.value = "请填写项目标题";
    return;
  }
  if (!w) {
    localError.value = "请填写工作目录";
    return;
  }
  localError.value = undefined;
  let created: ProjectSummary | undefined;
  const ok = await run(async () => {
    created = await props.client.call("POST /api/projects", {
      title: t,
      workspace: w,
    });
  });
  if (ok && created) {
    showToast(`已创建项目 · ${created.title}`);
    await props.onCreated(created);
    emit("close");
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  trapTab(event, formEl.value);
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="$emit('close')" @keydown="onKeydown">
    <form
      ref="formEl"
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-proj-title"
      @submit.prevent="submit"
    >
      <div class="modal-h">
        <h2 id="new-proj-title">新建项目</h2>
        <span class="spacer" />
        <button
          type="button"
          class="btn ghost sm icon"
          title="关闭"
          aria-label="关闭"
          @click="$emit('close')"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>
      <div class="modal-b">
        <div class="field">
          <label for="new-proj-name">标题</label>
          <input
            id="new-proj-name"
            ref="titleInput"
            v-model="title"
            class="input"
            placeholder="比如：光学论文《超表面偏振成像》"
            :disabled="busy"
          />
        </div>
        <div class="field">
          <label for="new-proj-ws">工作目录</label>
          <input
            id="new-proj-ws"
            v-model="workspace"
            class="input mono"
            placeholder="D:/papers/metasurface"
            :disabled="busy"
          />
          <span class="hint">
            Worker 在这里读写文件和运行命令。项目的对话、工单和记忆存在 ~/.eevee/projects/ 下，不写进工作目录。
          </span>
        </div>
        <div class="field">
          <label>等价命令</label>
          <div class="codeline">
            <code>eevee project create "{{ cliTitle }}" -w {{ cliWorkspace }}</code>
          </div>
        </div>
        <p v-if="localError || error" class="error" role="alert" style="margin: 0; font-size: 12px">
          {{ localError ?? error }}
        </p>
      </div>
      <div class="modal-f">
        <button type="button" class="btn" :disabled="busy" @click="$emit('close')">取消</button>
        <button
          type="submit"
          class="btn primary"
          :disabled="busy || !title.trim() || !workspace.trim()"
        >
          {{ busy ? "正在创建…" : "创建项目" }}
        </button>
      </div>
    </form>
  </div>
</template>
