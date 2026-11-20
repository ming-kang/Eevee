<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { ProjectSummary } from "@shared/api/contract.ts";
import { ref, watch } from "vue";
import { trapTab, useFocusReturn } from "../focus.ts";
import { t } from "../i18n.ts";
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

async function submit(): Promise<void> {
  const name = title.value.trim();
  const dir = workspace.value.trim();
  if (!name) {
    localError.value = t("Enter a project title");
    return;
  }
  if (!dir) {
    localError.value = t("Enter a working directory");
    return;
  }
  localError.value = undefined;
  let created: ProjectSummary | undefined;
  const ok = await run(async () => {
    created = await props.client.call("POST /api/projects", {
      title: name,
      workspace: dir,
    });
  });
  if (ok && created) {
    showToast(t("Created project · {title}", { title: created.title }));
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
        <h2 id="new-proj-title">{{ t("New project") }}</h2>
        <span class="spacer" />
        <button
          type="button"
          class="btn ghost sm icon"
          :aria-label="t('Close')"
          @click="$emit('close')"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>
      <div class="modal-b">
        <div class="field">
          <label for="new-proj-name">{{ t("Title") }}</label>
          <input
            id="new-proj-name"
            ref="titleInput"
            v-model="title"
            class="input"
            :disabled="busy"
          />
        </div>
        <div class="field">
          <label for="new-proj-ws">{{ t("Working directory") }}</label>
          <input
            id="new-proj-ws"
            v-model="workspace"
            class="input mono"
            :disabled="busy"
          />
        </div>
        <p v-if="localError || error" class="composer-error" role="alert">
          {{ localError ?? error }}
        </p>
      </div>
      <div class="modal-f">
        <button type="button" class="btn" :disabled="busy" @click="$emit('close')">{{ t("Cancel") }}</button>
        <button
          type="submit"
          class="btn primary"
          :disabled="busy || !title.trim() || !workspace.trim()"
        >
          {{ busy ? t("Creating…") : t("Create project") }}
        </button>
      </div>
    </form>
  </div>
</template>
