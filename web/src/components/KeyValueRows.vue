<script setup lang="ts">
import type { KeyValueRow } from "../fields.ts";
import { t } from "../i18n.ts";
import Icon from "./Icon.vue";

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
  <div class="kv" role="group" :aria-label="label">
    <div v-for="(row, index) in rows" :key="index" class="kv-row">
      <input
        v-model="row.key"
        class="input mono"
        spellcheck="false"
        autocomplete="off"
        :placeholder="keyPlaceholder"
        :aria-label="t('{label} 第 {n} 行的名称', { label, n: index + 1 })"
      />
      <input
        v-model="row.value"
        class="input mono"
        spellcheck="false"
        autocomplete="off"
        :placeholder="valuePlaceholder"
        :aria-label="t('{label} 第 {n} 行的值', { label, n: index + 1 })"
      />
      <button
        type="button"
        class="btn ghost sm icon"
        :aria-label="t('删除 {label} 第 {n} 行', { label, n: index + 1 })"
        @click="remove(index)"
      >
        <Icon name="x" size="xs" />
      </button>
    </div>
    <button type="button" class="btn ghost sm kv-add" @click="add">
      <Icon name="plus" size="xs" />
      <span>{{ t("添加一行") }}</span>
    </button>
  </div>
</template>
