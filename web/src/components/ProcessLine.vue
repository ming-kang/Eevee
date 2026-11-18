<script setup lang="ts">
import { computed } from "vue";
import { formatDurationMs } from "../time.ts";
import type { ToolStepItem } from "../transcript-map.ts";
import Icon from "./Icon.vue";

const props = defineProps<{
  steps: readonly ToolStepItem[];
  live?: boolean;
}>();

const VERB: Record<string, (n: number) => string> = {
  read: (n) => `查阅 ${n} 项`,
  bash: (n) => `运行 ${n} 条命令`,
  edit: (n) => `修改 ${n} 个文件`,
  write: (n) => `写入 ${n} 个文件`,
  memory: (n) => `记忆 ${n} 次`,
  tool_search: (n) => `查找工具 ${n} 次`,
  codemode: (n) => `执行脚本 ${n} 次`,
};

const runningStep = computed(() => props.steps.find((s) => s.status === "run"));
const hasError = computed(() => props.steps.some((s) => s.status === "err"));

const summary = computed(() => {
  const counts = new Map<string, number>();
  for (const step of props.steps) {
    counts.set(step.tool, (counts.get(step.tool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tool, count]) => (VERB[tool] ? VERB[tool](count) : `${tool} ×${count}`))
    .join("，");
});
</script>

<template>
  <details class="proc">
    <summary>
      <Icon name="chevR" size="xs" class="chev" />
      <span v-if="runningStep" class="ellipsis shimmer">
        正在{{ runningStep.tool === "read" ? "查阅" : runningStep.tool === "bash" ? "运行" : "执行" }}
        {{ runningStep.label }}
      </span>
      <template v-else>
        <span class="ellipsis">{{ summary }}</span>
        <span v-if="hasError" class="minus">· 失败</span>
      </template>
    </summary>
    <div class="steps">
      <div v-for="step in steps" :key="step.id" class="step">
        <div class="step-row">
          <Icon v-if="step.status === 'run'" name="spinner" size="xs" />
          <span v-else-if="step.status === 'err'" class="minus">
            <Icon name="x" size="xs" />
          </span>
          <span v-else class="dim">
            <Icon name="check" size="xs" />
          </span>
          <span class="tool">{{ step.tool }}</span>
          <span class="arg ellipsis">{{ step.label }}</span>
          <span class="ms">
            {{ step.ms !== undefined ? formatDurationMs(step.ms) : step.status === "run" ? "…" : "" }}
          </span>
        </div>
        <div v-if="step.output" class="step-out">{{ step.output }}</div>
      </div>
    </div>
  </details>
</template>
