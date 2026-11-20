<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { ProjectSummary } from "@shared/protocol/contract.ts";
import { ref, watch } from "vue";
import { useSubmit } from "../../composables/submit.ts";
import { showToast } from "../../composables/toasts.ts";
import { t } from "../../lib/i18n.ts";
import Button from "../../ui/Button.vue";
import Dialog from "../../ui/Dialog.vue";
import Input from "../../ui/Input.vue";
import { FIELD } from "../../ui/form.ts";
import { ERROR_TEXT } from "../../ui/surface.ts";
import DirListField from "./DirListField.vue";

const props = defineProps<{
  open: boolean;
  client: Client;
  onCreated: (project: ProjectSummary) => Promise<void> | void;
}>();

const emit = defineEmits<{
  close: [];
}>();

const title = ref("");
const dirs = ref<string[]>([]);
const dirsField = ref<{ commit(): void }>();
const localError = ref<string>();
const titleInput = ref<{ focus(): void }>();
const { busy, error, run } = useSubmit();

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    title.value = "";
    dirs.value = [];
    localError.value = undefined;
    error.value = undefined;
  },
);

async function submit(): Promise<void> {
  const name = title.value.trim();
  if (!name) {
    localError.value = t("Enter a project title");
    return;
  }
  dirsField.value?.commit();
  if (dirs.value.length === 0) {
    localError.value = t("Add at least one working directory");
    return;
  }
  localError.value = undefined;
  let created: ProjectSummary | undefined;
  const ok = await run(async () => {
    created = await props.client.call("POST /api/projects", {
      title: name,
      workspaces: dirs.value,
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
      <label id="new-proj-dirs-label">{{ t("Working directories") }}</label>
      <div role="group" aria-labelledby="new-proj-dirs-label">
        <DirListField ref="dirsField" v-model="dirs" :client="client" :disabled="busy" />
      </div>
    </div>
    <p v-if="localError || error" :class="ERROR_TEXT" role="alert">
      {{ localError ?? error }}
    </p>
    <template #footer>
      <Button :disabled="busy" @click="$emit('close')">{{ t("Cancel") }}</Button>
      <Button type="submit" variant="primary" :disabled="busy || !title.trim()">
        {{ busy ? t("Creating…") : t("Create project") }}
      </Button>
    </template>
  </Dialog>
</template>
