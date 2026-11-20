<script setup lang="ts">
import type { KeyValueRow } from "../lib/fields.ts";
import { t } from "../lib/i18n.ts";
import Icon from "./Icon.vue";
import Button from "../ui/Button.vue";
import Input from "../ui/Input.vue";

/** Edits a string map in place, one row per entry. */
const props = defineProps<{
  rows: KeyValueRow[];
  label: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
}>();

function add(): void {
  props.rows.push({ key: "", value: "" });
}

function remove(index: number): void {
  props.rows.splice(index, 1);
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5" role="group" :aria-label="label">
    <div v-for="(row, index) in rows" :key="index" class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-1.5">
      <Input v-model="row.key" mono spellcheck="false" autocomplete="off" :placeholder="keyPlaceholder" :aria-label="t('{label}, row {n}: name', { label, n: index + 1 })" />
      <Input v-model="row.value" mono spellcheck="false" autocomplete="off" :placeholder="valuePlaceholder" :aria-label="t('{label}, row {n}: value', { label, n: index + 1 })" />
      <Button variant="ghost" size="sm" icon :aria-label="t('Remove {label} row {n}', { label, n: index + 1 })" @click="remove(index)">
        <Icon name="x" size="xs" />
      </Button>
    </div>
    <Button variant="ghost" size="sm" class="self-start" @click="add">
      <Icon name="plus" size="xs" />
      <span>{{ t("Add a row") }}</span>
    </Button>
  </div>
</template>
