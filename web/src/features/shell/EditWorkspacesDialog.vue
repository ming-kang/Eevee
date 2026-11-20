<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { ProjectSummary } from "@shared/protocol/contract.ts";
import { ref, watch } from "vue";
import { useSubmit } from "../../composables/submit.ts";
import { showToast } from "../../composables/toasts.ts";
import { t } from "../../lib/i18n.ts";
import Button from "../../ui/Button.vue";
import Dialog from "../../ui/Dialog.vue";
import { FIELD } from "../../ui/form.ts";
import { ERROR_TEXT } from "../../ui/surface.ts";
import DirListField from "./DirListField.vue";

const props = defineProps<{
  open: boolean;
  client: Client;
  project: ProjectSummary;
}>();

const emit = defineEmits<{
  close: [];
  changed: [];
}>();

const dirs = ref<string[]>([]);
const dirsField = ref<{ commit(): void }>();
const { busy, error, run } = useSubmit();

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    dirs.value = [...props.project.workspaces];
    error.value = undefined;
  },
);

async function save(): Promise<void> {
  dirsField.value?.commit();
  const ok = await run(async () => {
    await props.client.call(
      "PUT /api/projects/:project",
      { project: props.project.id },
      { workspaces: dirs.value },
    );
  });
  if (ok) {
    showToast(t("Directories saved"));
    emit("changed");
    emit("close");
  }
}
</script>

<template>
  <Dialog
    :open="open"
    :title="t('Edit directories')"
    as="form"
    @close="$emit('close')"
    @submit="save"
  >
    <div :class="FIELD">
      <label id="edit-dirs-label">{{ t("Working directories") }}</label>
      <div role="group" aria-labelledby="edit-dirs-label">
        <DirListField ref="dirsField" v-model="dirs" :client="client" :disabled="busy" />
      </div>
    </div>
    <p v-if="error" :class="ERROR_TEXT" role="alert">{{ error }}</p>
    <template #footer>
      <Button :disabled="busy" @click="$emit('close')">{{ t("Cancel") }}</Button>
      <Button type="submit" variant="primary" :disabled="busy || dirs.length === 0">
        {{ busy ? t("Saving…") : t("Save") }}
      </Button>
    </template>
  </Dialog>
</template>
