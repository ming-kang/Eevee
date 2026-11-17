<script setup lang="ts">
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
      <Icon v-if="status === 'run'" name="spinner" size="xs" />
      <Icon v-else name="chevR" size="xs" class="chev" />
      <span class="ellipsis">
        {{ status === "run" ? "正在" : "" }}{{ action === "write" ? "写入" : "修改" }}
        {{ " " }}<span class="mono" style="font-size: 12px">{{ path }}</span>
      </span>
      <span v-if="status === 'err'" class="minus">· 失败</span>
      <template v-else-if="status === 'ok'">
        <span v-if="added > 0" class="plus mono" style="font-size: 11px">+{{ added }}</span>
        <span v-if="removed > 0" class="minus mono" style="font-size: 11px">−{{ removed }}</span>
      </template>
    </summary>
    <div v-if="error" class="step-out" style="white-space: pre-wrap">{{ error }}</div>
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
