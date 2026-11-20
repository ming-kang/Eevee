<script setup lang="ts">
import type { MemoryChangeDetail } from "@shared/contracts/index.ts";
import { t } from "../i18n.ts";
import Icon from "./Icon.vue";

defineProps<{
  diffs: MemoryChangeDetail["files"];
  emptyText?: string;
}>();
</script>

<template>
  <p v-if="diffs.length === 0" class="hint">
    {{ emptyText ?? t("No text changes") }}
  </p>
  <template v-else>
    <div v-for="file in diffs" :key="file.path" class="card file-diff">
      <div class="card-h">
        <Icon name="file" size="sm" />
        <span class="path">{{ file.path }}</span>
        <span v-if="file.status === 'added'" class="chip">{{ t("New") }}</span>
        <span v-else-if="file.status === 'deleted'" class="chip">{{ t("Deleted") }}</span>
        <span class="spacer" />
        <span v-if="!file.binary" class="stat">
          <span class="plus">+{{ file.added }}</span>
          {{ " " }}
          <span class="minus">−{{ file.removed }}</span>
        </span>
      </div>
      <div v-if="file.binary" class="hint card-note">{{ t("Binary file") }}</div>
      <div v-else class="diff">
        <template v-for="(hunk, hi) in file.hunks" :key="hi">
          <div class="hunk">{{ hunk.header }}</div>
          <div v-for="(line, li) in hunk.lines" :key="li" class="ln" :class="line.kind">
            <span>{{ line.old ?? "" }}</span>
            <span>{{ line.new ?? "" }}</span>
            <span class="mk">{{ line.kind === "add" ? "+" : line.kind === "del" ? "−" : "" }}</span>
            <span>{{ line.text }}</span>
          </div>
        </template>
      </div>
    </div>
  </template>
</template>
