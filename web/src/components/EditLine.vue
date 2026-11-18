<script setup lang="ts">
import { t } from "../i18n.ts";
import type { DiffLine } from "../transcript-map.ts";
import Icon from "./Icon.vue";

defineProps<{
  action: "edit" | "write";
  path: string;
  status: "ok" | "err" | "run";
  diff: readonly DiffLine[];
  added: number;
  removed: number;
  error?: string;
}>();
</script>

<template>
  <details class="proc">
    <summary>
      <Icon name="chevR" size="xs" class="chev" />
      <span class="ellipsis" :class="{ shimmer: status === 'run' }">
        {{
          status === "run"
            ? action === "write"
              ? t("Writing")
              : t("Editing")
            : action === "write"
              ? t("Wrote")
              : t("Edited")
        }}
        {{ " " }}<span class="mono">{{ path }}</span>
      </span>
      <span v-if="status === 'err'" class="minus">· {{ t("Failed") }}</span>
      <span v-else-if="status === 'ok' && (added > 0 || removed > 0)" class="diffstat">
        <span v-if="added > 0" class="plus">+{{ added }}</span>
        <span v-if="removed > 0" class="minus">−{{ removed }}</span>
      </span>
    </summary>
    <div v-if="error" class="step-out">{{ error }}</div>
    <div v-else-if="diff.length > 0" class="diff single">
      <template v-for="(line, index) in diff" :key="index">
        <div v-if="line.k === 'hunk'" class="hunk">{{ line.s }}</div>
        <div v-else class="ln" :class="line.k">
          <span>{{ line.n }}</span>
          <span class="mk">{{ line.k === "add" ? "+" : line.k === "del" ? "−" : "" }}</span>
          <span>{{ line.s }}</span>
        </div>
      </template>
    </div>
  </details>
</template>
