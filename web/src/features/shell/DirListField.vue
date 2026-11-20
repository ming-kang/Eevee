<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import { ref, watch } from "vue";
import { t } from "../../lib/i18n.ts";
import Button from "../../ui/Button.vue";
import Icon from "../../ui/Icon.vue";
import Input from "../../ui/Input.vue";
import DirectoryBrowserDialog from "./DirectoryBrowserDialog.vue";

defineProps<{
  client: Client;
  disabled?: boolean;
}>();

/** The directories picked so far, first being the default. */
const dirs = defineModel<string[]>({ required: true });

const dirText = ref("");
const browsing = ref(false);

// A parent that empties the list (a dialog reopening) also drops the pending input.
watch(dirs, (value) => {
  if (value.length === 0) dirText.value = "";
});

function addDir(dir: string): void {
  const trimmed = dir.trim();
  if (trimmed === "" || dirs.value.includes(trimmed)) return;
  dirs.value = [...dirs.value, trimmed];
  dirText.value = "";
}

/** The pending input, added as if the user had clicked Add; call before submitting. */
function commit(): void {
  addDir(dirText.value);
}

defineExpose({ commit });
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div v-for="(dir, index) in dirs" :key="`${dir}:${index}`" class="flex items-center gap-1.5">
      <span
        class="mono min-w-0 flex-1 truncate rounded-md border border-border bg-(--ev-page) px-2.5 py-1.5 text-sm"
        :title="dir"
      >
        {{ dir }}
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon
        :disabled="disabled"
        :aria-label="t('Remove')"
        @click="dirs = dirs.filter((_, i) => i !== index)"
      >
        <Icon name="x" size="sm" />
      </Button>
    </div>
    <div class="flex items-center gap-1.5">
      <Input
        v-model="dirText"
        mono
        :disabled="disabled"
        :placeholder="t('Add a directory')"
        class="min-w-0 flex-1"
        @keydown.enter.prevent="commit"
      />
      <Button size="sm" :disabled="disabled || dirText.trim() === ''" @click="commit">
        {{ t("Add") }}
      </Button>
      <Button size="sm" :disabled="disabled" @click="browsing = true">{{ t("Browse…") }}</Button>
    </div>
    <DirectoryBrowserDialog
      :open="browsing"
      :client="client"
      :start="dirText.trim() || undefined"
      @close="browsing = false"
      @pick="addDir"
    />
  </div>
</template>
