<script setup lang="ts">
import type { MemoryChangeDetail } from "@shared/contracts/index.ts";
import { t } from "../../lib/i18n.ts";
import Icon from "../../ui/Icon.vue";
import { PANEL, badge } from "../../ui/surface.ts";
import { diff } from "../../ui/diff.ts";

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
    <div v-for="file in diffs" :key="file.path" class="file-diff [.file-diff+&]:mt-3" :class="PANEL">
      <div class="flex min-h-10 items-center gap-2 border-b border-separator px-3.5 text-sm font-medium text-fg">
        <Icon name="file" size="sm" />
        <span class="min-w-0 truncate font-mono text-xs leading-none font-medium">{{ file.path }}</span>
        <span v-if="file.status === 'added'" :class="badge()">{{ t("New") }}</span>
        <span v-else-if="file.status === 'deleted'" :class="badge()">{{ t("Deleted") }}</span>
        <span class="spacer" />
        <span v-if="!file.binary" class="font-mono text-xs leading-none">
          <span class="plus">+{{ file.added }}</span>
          {{ " " }}
          <span class="minus">−{{ file.removed }}</span>
        </span>
      </div>
      <div v-if="file.binary" class="hint px-3.5 py-3">{{ t("Binary file") }}</div>
      <div v-else :class="diff()">
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
