<script setup lang="ts">
import type { ProjectSummary } from "@shared/api/contract.ts";
import { t } from "../i18n.ts";
import type { ProjectRowState } from "../projects.ts";
import { formatRelativeTime } from "../time.ts";
import StageGlyph from "./StageGlyph.vue";

defineProps<{
  visible: boolean;
  project: ProjectSummary | undefined;
  state: ProjectRowState | undefined;
  boardLoaded: boolean;
  top: number;
  left: number;
}>();
</script>

<template>
  <div
    class="hovercard"
    :class="{ on: visible && project !== undefined }"
    :style="{ top: `${top}px`, left: `${left}px` }"
    aria-hidden="true"
  >
    <template v-if="project && state">
      <div class="hc-title">{{ project.title }}</div>
      <div class="hc-ws mono">{{ project.workspace }}</div>
      <div class="hc-body">
        <div v-if="state.questionCount > 0" class="hc-line user">
          <StageGlyph stage="answer" />
          <span>{{ t("{n} question needs an answer|{n} questions need an answer", { n: state.questionCount }) }}</span>
        </div>
        <div v-if="state.routerFailed" class="hc-line bad">
          <StageGlyph stage="blocked" />
          <span>{{ t("The Router's last turn didn't finish") }}</span>
        </div>
        <div v-if="!boardLoaded" class="hc-line">
          <StageGlyph stage="idle" />
          <span>{{ t("Fetching tickets…") }}</span>
        </div>
        <div v-else-if="state.openCount > 0" class="hc-line">
          <StageGlyph :stage="state.runningTickets > 0 ? 'working' : 'idle'" />
          <span>
            {{ t("{n} open", { n: state.openCount }) }}
            <template v-if="state.runningTickets > 0">
              · {{ t("{n} working", { n: state.runningTickets }) }}
            </template>
            <template v-if="state.jobCount > 0"> · {{ t("{n} job|{n} jobs", { n: state.jobCount }) }}</template>
          </span>
        </div>
        <div v-else class="hc-line">
          <StageGlyph stage="idle" />
          <span>{{ t("No open tickets") }}</span>
        </div>
        <div v-if="state.routerRunning" class="hc-line">
          <StageGlyph stage="working" />
          <span>{{ t("The Router is working") }}</span>
        </div>
      </div>
      <div v-if="state.activeAt !== undefined" class="hc-foot">
        {{ t("Last active {time}", { time: formatRelativeTime(state.activeAt) }) }}
      </div>
    </template>
  </div>
</template>
