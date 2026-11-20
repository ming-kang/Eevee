<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../lib/i18n.ts";
import Dialog from "../../ui/Dialog.vue";
import Button from "../../ui/Button.vue";
import Input from "../../ui/Input.vue";
import { fieldClass } from "../../ui/field.ts";
import type { MemoryEditor } from "./editor.ts";

const props = defineProps<{ editor: MemoryEditor }>();
const draft = computed(() => props.editor.draft.value);
const title = computed(() => {
  switch (draft.value?.mode) {
    case "new": return t("New memory file");
    case "rename": return t("Rename memory file");
    case "delete": return t("Delete memory file?");
    default: return t("Edit memory file");
  }
});
const disabled = computed(() => props.editor.busy.value || !draft.value?.loaded ||
  (draft.value.mode === "rename" && draft.value.name === draft.value.file) ||
  ((draft.value.mode === "new" || draft.value.mode === "rename") && !draft.value.name.trim()));
</script>

<template>
  <Dialog :open="draft !== undefined" :title="title" as="form"
    @close="!editor.busy.value && editor.close()" @submit="editor.submit()">
    <template v-if="draft">
      <label v-if="draft.mode === 'new' || draft.mode === 'rename'" class="flex flex-col gap-1.5">
        <span>{{ t("File name") }}</span>
        <Input v-model="draft.name" mono :disabled="editor.busy.value" required />
      </label>
      <p v-else class="mono text-sm wrap-anywhere">{{ draft.file }}</p>
      <p v-if="draft.mode === 'delete'" class="muted">{{ t("Delete this file? You can undo the change from History.") }}</p>
      <label v-if="draft.mode === 'edit' || draft.mode === 'new'" class="flex flex-col gap-1.5">
        <span>{{ t("Content") }}</span>
        <textarea v-model="draft.content" :disabled="editor.busy.value || !draft.loaded"
          rows="14" spellcheck="false" :class="[fieldClass({ mono: true, multiline: true }), 'min-h-48']" />
      </label>
      <p v-if="editor.busy.value && !draft.loaded" class="hint">{{ t("Loading…") }}</p>
      <p v-if="editor.error.value" class="error hint" role="alert">{{ editor.error.value }}</p>
      <Button v-if="editor.changed.value || (!draft.loaded && !editor.busy.value)" :disabled="editor.busy.value"
        @click="editor.reload()">{{ t("Reload latest content") }}</Button>
    </template>
    <template #footer>
      <Button :disabled="editor.busy.value" @click="editor.close()">{{ t("Cancel") }}</Button>
      <Button :variant="draft?.mode === 'delete' ? 'danger' : 'primary'" type="submit" :disabled="disabled">
        {{ draft?.mode === 'delete' ? t("Delete") : draft?.mode === 'rename' ? t("Rename") : t("Save") }}
      </Button>
    </template>
  </Dialog>
</template>
