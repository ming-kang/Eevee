<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n.ts";
import { formatDurationMs } from "../time.ts";
import type { ToolStepItem } from "../transcript-map.ts";
import Icon from "./Icon.vue";

const props = defineProps<{
  steps: readonly ToolStepItem[];
  live?: boolean;
}>();

const VERB: Record<string, (n: number) => string> = {
  read: (n) => t("Read {n} item|Read {n} items", { n }),
  bash: (n) => t("Ran {n} command|Ran {n} commands", { n }),
  edit: (n) => t("Edited {n} file|Edited {n} files", { n }),
  write: (n) => t("Wrote {n} file|Wrote {n} files", { n }),
  memory: (n) => t("Used memory once|Used memory {n} times", { n }),
  tool_search: (n) => t("Searched tools once|Searched tools {n} times", { n }),
  codemode: (n) => t("Ran a script|Ran {n} scripts", { n }),
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
    .join(" · ");
});
</script>

<template>
  <details class="proc">
    <summary>
      <Icon name="chevR" size="xs" class="chev" />
      <span v-if="runningStep" class="ellipsis shimmer">
        {{
          runningStep.tool === "read"
            ? t("Reading")
            : runningStep.tool === "bash"
              ? t("Running::command")
              : t("Executing")
        }}
        {{ runningStep.label }}
      </span>
      <template v-else>
        <span class="ellipsis">{{ summary }}</span>
        <span v-if="hasError" class="minus">· {{ t("Failed") }}</span>
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
