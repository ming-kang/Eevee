<script setup lang="ts">
import type { ProjectSummary } from "@shared/protocol/contract.ts";
import { t } from "../../lib/i18n.ts";
import type { ProjectRowState } from "../../lib/projects.ts";
import { formatRelativeTime } from "../../lib/time.ts";
import StageGlyph from "../project/StageGlyph.vue";

defineProps<{
  visible: boolean;
  project: ProjectSummary | undefined;
  state: ProjectRowState | undefined;
  boardLoaded: boolean;
  top: number;
  left: number;
}>();

const HC_LINE = "flex items-center gap-2 text-xs [&_.glyph]:size-(--ev-icon-xs)";
</script>

<template>
  <div
    class="pointer-events-none absolute left-[clamp(8px,var(--hc-left),calc(100cqw_-_var(--hc-width)_-_8px))] z-60 w-(--hc-width) rounded-lg border border-border bg-(--ev-glass-bg) px-3.5 py-3 shadow-(--ev-shadow-float) backdrop-blur-(--ev-glass-blur) backdrop-saturate-(--ev-glass-sat) [--ev-glyph-cut:var(--ev-raised)] [--hc-width:min(calc(272px*var(--ev-scale)),calc(100cqw_-_16px))]"
    :class="visible && project !== undefined ? 'visible translate-y-0 opacity-100 [transition:opacity_var(--ev-regular)_var(--ev-ease),translate_var(--ev-regular)_var(--ev-ease)]' : 'invisible translate-y-1 opacity-0 [transition:opacity_var(--ev-regular)_var(--ev-ease),translate_var(--ev-regular)_var(--ev-ease),visibility_0s_linear_var(--ev-regular)]'"
    :style="{ top: `${top}px`, '--hc-left': `${left}px` }"
    aria-hidden="true"
  >
    <template v-if="project && state">
      <div class="text-base font-semibold tracking-(--ev-tracking) wrap-anywhere">{{ project.title }}</div>
      <div class="mono mt-0.5 truncate text-xs text-fg-subtle">{{ project.workspace }}</div>
      <div class="mt-2.5 flex flex-col gap-1.5">
        <div v-if="state.questionCount > 0" :class="[HC_LINE, 'text-(color:--ev-user-ink)']">
          <StageGlyph stage="answer" />
          <span>{{ t("{n} question needs an answer|{n} questions need an answer", { n: state.questionCount }) }}</span>
        </div>
        <div v-if="state.routerFailed" :class="[HC_LINE, 'text-(color:--ev-bad-ink)']">
          <StageGlyph stage="blocked" />
          <span>{{ t("The Router's last turn didn't finish") }}</span>
        </div>
        <div v-if="!boardLoaded" :class="[HC_LINE, 'text-fg-muted']">
          <StageGlyph stage="idle" />
          <span>{{ t("Fetching tickets…") }}</span>
        </div>
        <div v-else-if="state.openCount > 0" :class="[HC_LINE, 'text-fg-muted']">
          <StageGlyph :stage="state.runningTickets > 0 ? 'working' : 'idle'" />
          <span>
            {{ t("{n} open", { n: state.openCount }) }}
            <template v-if="state.runningTickets > 0">
              · {{ t("{n} working", { n: state.runningTickets }) }}
            </template>
            <template v-if="state.jobCount > 0"> · {{ t("{n} job|{n} jobs", { n: state.jobCount }) }}</template>
          </span>
        </div>
        <div v-else :class="[HC_LINE, 'text-fg-muted']">
          <StageGlyph stage="idle" />
          <span>{{ t("No open tickets") }}</span>
        </div>
        <div v-if="state.routerRunning" :class="[HC_LINE, 'text-fg-muted']">
          <StageGlyph stage="working" />
          <span>{{ t("The Router is working") }}</span>
        </div>
      </div>
      <div v-if="state.activeAt !== undefined" class="mt-2.5 text-xs text-fg-subtle">
        {{ t("Last active {time}", { time: formatRelativeTime(state.activeAt) }) }}
      </div>
    </template>
  </div>
</template>
