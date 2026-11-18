<script setup lang="ts">
import { isFinalReport, type Report } from "@shared/contracts/index.ts";
import { computed } from "vue";
import { reportStage } from "../board.ts";
import { t } from "../i18n.ts";
import { REPORT_LABEL, reportNeed, reportSummary } from "../labels.ts";
import { formatRelativeTime } from "../time.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";

const props = defineProps<{
  report: Report;
  full?: boolean;
  nowMs?: number;
}>();

const stage = computed(() => reportStage(props.report.status));
const final = computed(() => isFinalReport(props.report.status));
const when = computed(() => formatRelativeTime(props.report.at, props.nowMs));
const summary = computed(() => reportSummary(props.report));
const need = computed(() => reportNeed(props.report));
const hasDetails = computed(
  () =>
    Boolean(need.value) ||
    props.report.artifacts.length > 0 ||
    (props.report.lessons?.length ?? 0) > 0,
);
</script>

<template>
  <div v-if="report.status === 'progress' && !full" class="note">
    <Icon name="flag" size="xs" />
    <span>{{ t("Progress: {summary}", { summary }) }}</span>
  </div>
  <div v-else class="report">
    <div class="report-h">
      <StageGlyph :stage="stage" />
      <span>{{ t("Report #{seq} · {status}", { seq: report.seq, status: REPORT_LABEL[report.status] }) }}</span>
      <span v-if="final && !report.handled">· {{ t("waiting for the Router") }}</span>
      <span class="spacer" />
      <span class="dim">{{ when }}</span>
    </div>
    <div class="report-sum">{{ summary }}</div>
    <dl v-if="hasDetails" class="kv">
      <template v-if="need">
        <dt>{{ t("Needs") }}</dt>
        <dd>{{ need }}</dd>
      </template>
      <template v-if="report.artifacts.length > 0">
        <dt>{{ t("Artifacts") }}</dt>
        <dd>
          <template v-for="(artifact, index) in report.artifacts" :key="artifact.path + index">
            <template v-if="index > 0">{{ t("; ") }}</template>
            <span class="mono">{{ artifact.path }}</span>
            <template v-if="artifact.note">
              {{ " " }}<span class="dim">{{ artifact.note }}</span>
            </template>
          </template>
        </dd>
      </template>
      <template v-if="report.lessons && report.lessons.length > 0">
        <dt>{{ t("Lessons") }}</dt>
        <dd>{{ report.lessons.join(t("; ")) }}</dd>
      </template>
    </dl>
    <details v-if="full && report.detail" class="proc">
      <summary>
        <Icon name="chevR" size="xs" class="chev" />
        <span>{{ t("Details::full") }}</span>
      </summary>
      <div class="step-out">{{ report.detail }}</div>
    </details>
  </div>
</template>
