<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { formatModel, type ModelDefaults, pickModel } from "@shared/contracts/index.ts";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { effectiveStage } from "../board.ts";
import { t } from "../i18n.ts";
import { STAGE_LABEL } from "../labels.ts";
import { formatRelativeTime } from "../time.ts";
import Icon from "./Icon.vue";
import ReportCard from "./ReportCard.vue";
import Skeleton from "./Skeleton.vue";
import StageGlyph from "./StageGlyph.vue";
import TicketRef from "./TicketRef.vue";

const props = defineProps<{
  ticketId?: string;
  view: TicketView | undefined;
  tickets?: readonly TicketView[];
  projectModels?: ModelDefaults;
  loaded: boolean;
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const nowMs = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  timer = setInterval(() => {
    nowMs.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer);
});

const stage = computed(() => (props.view ? effectiveStage(props.view) : undefined));

const sortedReports = computed(() =>
  props.view ? [...props.view.reports].sort((a, b) => b.seq - a.seq) : [],
);

const modelInfo = computed(() => {
  const ticket = props.view?.ticket;
  if (!ticket) return { text: undefined, mono: false, hint: undefined };
  if (ticket.model) {
    return {
      text: formatModel(ticket.model),
      mono: true,
      hint: ticket.modelReason ?? t("Chosen for this ticket"),
    };
  }
  const projectDefault = pickModel(ticket.role, props.projectModels);
  if (projectDefault) {
    return {
      text: formatModel(projectDefault),
      mono: true,
      hint: t("Project default"),
    };
  }
  return {
    text: ticket.role === "dreamer" ? t("Dreamer default") : t("Worker default"),
    mono: false,
    hint: undefined,
  };
});
</script>

<template>
  <div v-if="!view && !loaded" class="rdetail"><Skeleton :lines="4" /></div>
  <p v-else-if="!view" class="rail-empty">{{ t("Ticket {id} not found", { id: ticketId ?? "" }) }}</p>
  <div v-else class="rdetail">
    <div v-if="stage" class="rd-meta">
      <StageGlyph :stage="stage" />
      <span class="t-stage" :class="`s-${stage}`">{{ STAGE_LABEL[stage] }}</span>
      <span class="t-id">{{ view.ticket.id }}</span>
      <span class="dim">·</span>
      <span>{{ t("Created {time}", { time: formatRelativeTime(view.ticket.createdAt, nowMs) }) }}</span>
      <template v-if="view.ticket.closedAt">
        <span class="dim">·</span>
        <span>{{ t("Closed {time}", { time: formatRelativeTime(view.ticket.closedAt, nowMs) }) }}</span>
      </template>
    </div>

    <dl class="brief">
      <div class="b-item">
        <dt>{{ t("Goal") }}</dt>
        <dd>
          <span>{{ view.ticket.goal || "—" }}</span>
        </dd>
      </div>

      <div v-if="view.ticket.inputs.length > 0" class="b-item">
        <dt>{{ t("Input") }}</dt>
        <dd>
          <span v-for="(input, index) in view.ticket.inputs" :key="index" class="mono">
            {{ input }}
          </span>
        </dd>
      </div>

      <div v-if="view.ticket.acceptance.length > 0" class="b-item">
        <dt>{{ t("Acceptance criteria") }}</dt>
        <dd>
          <ul>
            <li v-for="(item, index) in view.ticket.acceptance" :key="index">
              <Icon name="check" size="xs" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </dd>
      </div>

      <div v-if="view.ticket.output" class="b-item">
        <dt>{{ t("Artifacts") }}</dt>
        <dd>
          <span class="mono">{{ view.ticket.output }}</span>
        </dd>
      </div>

      <div v-if="view.ticket.deliverTo.length > 0" class="b-item">
        <dt>{{ t("Delivers to") }}</dt>
        <dd>
          <span>
            <template v-for="(targetId, index) in view.ticket.deliverTo" :key="targetId">
              <template v-if="index > 0">{{ t(", ") }}</template>
              <TicketRef
                :ticket-id="targetId"
                :tickets="tickets"
                @open-ticket="$emit('open-ticket', $event)"
              />
            </template>
          </span>
        </dd>
      </div>

      <div class="b-item">
        <dt>{{ t("Model") }}</dt>
        <dd>
          <span v-if="modelInfo.text" :class="modelInfo.mono ? 'mono' : 'muted'">
            {{ modelInfo.text }}
          </span>
          <span v-if="modelInfo.hint" class="hint">{{ modelInfo.hint }}</span>
        </dd>
      </div>

      <div v-if="view.ticket.closeNote" class="b-item">
        <dt>{{ t("Close note") }}</dt>
        <dd>
          <span>{{ view.ticket.closeNote }}</span>
        </dd>
      </div>
    </dl>

    <div class="rd-reports">
      <div class="section-h">{{ t("Reports") }}</div>
      <div v-if="sortedReports.length > 0" class="rlist">
        <ReportCard
          v-for="report in sortedReports"
          :key="report.seq"
          :report="report"
          :now-ms="nowMs"
          full
        />
      </div>
      <p v-else class="hint">{{ t("No reports") }}</p>
    </div>
  </div>
</template>
