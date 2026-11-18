<script setup lang="ts">
import { isFinalReport, type Report } from "@shared/contracts/index.ts";
import { computed } from "vue";
import { reportStage } from "../board.ts";
import { t } from "../i18n.ts";
import { REPORT_LABEL } from "../labels.ts";
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
const hasDetails = computed(
  () =>
    Boolean(props.report.need) ||
    props.report.artifacts.length > 0 ||
    (props.report.lessons?.length ?? 0) > 0,
);
</script>

<template>
  <div v-if="report.status === 'progress' && !full" class="note">
    <Icon name="flag" size="xs" />
    <span>{{ t("进展：{summary}", { summary: report.summary }) }}</span>
  </div>
  <div v-else class="report">
    <div class="report-h">
      <StageGlyph :stage="stage" />
      <span>{{ t("报告 #{seq} · {status}", { seq: report.seq, status: REPORT_LABEL[report.status] }) }}</span>
      <span v-if="final && !report.handled">· {{ t("等 Router 处理") }}</span>
      <span class="spacer" />
      <span class="dim">{{ when }}</span>
    </div>
    <div class="report-sum">{{ report.summary }}</div>
    <dl v-if="hasDetails" class="kv">
      <template v-if="report.need">
        <dt>{{ t("需要") }}</dt>
        <dd>{{ report.need }}</dd>
      </template>
      <template v-if="report.artifacts.length > 0">
        <dt>{{ t("产物") }}</dt>
        <dd>
          <template v-for="(artifact, index) in report.artifacts" :key="artifact.path + index">
            <template v-if="index > 0">{{ t("；") }}</template>
            <span class="mono">{{ artifact.path }}</span>
            <template v-if="artifact.note">
              {{ " " }}<span class="dim">{{ artifact.note }}</span>
            </template>
          </template>
        </dd>
      </template>
      <template v-if="report.lessons && report.lessons.length > 0">
        <dt>{{ t("经验") }}</dt>
        <dd>{{ report.lessons.join(t("；")) }}</dd>
      </template>
    </dl>
    <details v-if="full && report.detail" class="proc">
      <summary>
        <Icon name="chevR" size="xs" class="chev" />
        <span>{{ t("详细说明") }}</span>
      </summary>
      <div class="step-out">{{ report.detail }}</div>
    </details>
  </div>
</template>
