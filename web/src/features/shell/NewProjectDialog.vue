<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { ProjectSummary } from "@shared/protocol/contract.ts";
import { ref, watch } from "vue";
import { t } from "../../lib/i18n.ts";
import { useSubmit } from "../../composables/submit.ts";
import { showToast } from "../../composables/toasts.ts";
import Icon from "../../ui/Icon.vue";
import Button from "../../ui/Button.vue";
import Dialog from "../../ui/Dialog.vue";
import Input from "../../ui/Input.vue";
import { ERROR_TEXT } from "../../ui/surface.ts";
import { FIELD } from "../../ui/form.ts";

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
const titleInput = ref<{ focus(): void }>();
const { busy, error, run } = useSubmit();

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

function focusTitle(event: Event): void {
  event.preventDefault();
  titleInput.value?.focus();
}
</script>

<template>
  <Dialog :open="open" :title="t('New project')" as="form" @close="$emit('close')" @submit="submit" @open-auto-focus="focusTitle">
    <div :class="FIELD">
      <label for="new-proj-name">{{ t("Title") }}</label>
      <Input id="new-proj-name" ref="titleInput" v-model="title" :disabled="busy" />
    </div>
    <div :class="FIELD">
      <label for="new-proj-ws">{{ t("Working directory") }}</label>
      <Input id="new-proj-ws" v-model="workspace" mono :disabled="busy" />
    </div>
    <p v-if="localError || error" :class="ERROR_TEXT" role="alert">
      {{ localError ?? error }}
    </p>
    <template #footer>
      <Button :disabled="busy" @click="$emit('close')">{{ t("Cancel") }}</Button>
      <Button type="submit" variant="primary" :disabled="busy || !title.trim() || !workspace.trim()">
        {{ busy ? t("Creating…") : t("Create project") }}
      </Button>
    </template>
  </Dialog>
</template>
