<script setup lang="ts">
import { computed, ref } from "vue";
import { activityLabel, countSteps, runningLabel } from "../../lib/activity.ts";
import { t } from "../../lib/i18n.ts";
import { formatDurationMs } from "../../lib/time.ts";
import type { ToolStepItem } from "../../lib/transcript-map.ts";
import Icon from "../../ui/Icon.vue";
import ToolSheet from "./ToolSheet.vue";
import { STEP_ROW, STEPS } from "./steps.ts";

const props = defineProps<{
  steps: readonly ToolStepItem[];
  live?: boolean;
}>();

const runningStep = computed(() => props.steps.find((s) => s.status === "run"));
const hasError = computed(() => props.steps.some((s) => s.status === "err"));

const summary = computed(() => activityLabel(countSteps(props.steps)));

/** The running step reads "Reading · src/a.ts"; a bare tool name adds no detail. */
const runningText = computed(() => {
  const step = runningStep.value;
  if (step === undefined) return "";
  return runningLabel(step.tool, step.label === step.tool ? undefined : step.label);
});

/** One step's sheet at a time: opening another closes the last. */
const openStep = ref<string>();
function toggle(step: ToolStepItem): void {
  openStep.value = openStep.value === step.id ? undefined : step.id;
}
</script>

<template>
  <details class="proc">
    <summary>
      <Icon name="chevR" size="xs" class="chev" />
      <span v-if="runningStep" class="ellipsis shimmer">{{ runningText }}</span>
      <template v-else>
        <span class="ellipsis">{{ summary }}</span>
        <span v-if="hasError" class="minus">· {{ t("Failed") }}</span>
      </template>
    </summary>
    <div :class="STEPS">
      <template v-for="step in steps" :key="step.id">
        <button
          type="button"
          :class="[STEP_ROW, 'w-full rounded-sm text-left transition-colors hover:bg-hover focus-visible:shadow-(--ev-ring-in)']"
          :aria-expanded="openStep === step.id"
          @click="toggle(step)"
        >
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
        </button>
        <ToolSheet
          v-if="openStep === step.id"
          :label="step.label"
          :output="step.output"
          :meta="step.status === 'err' ? t('Failed') : undefined"
        />
      </template>
    </div>
  </details>
</template>
