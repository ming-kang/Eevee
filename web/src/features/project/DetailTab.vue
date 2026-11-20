<script setup lang="ts">
import type { TicketView } from "@shared/protocol/contract.ts";
import { formatModel, type ModelDefaults, pickModel } from "@shared/domain/index.ts";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { effectiveStage } from "../../lib/board.ts";
import { t } from "../../lib/i18n.ts";
import { STAGE_LABEL } from "../../lib/labels.ts";
import { formatRelativeTime } from "../../lib/time.ts";
import Icon from "../../ui/Icon.vue";
import ReportCard from "./ReportCard.vue";
import Skeleton from "../../ui/Skeleton.vue";
import StageGlyph from "./StageGlyph.vue";
import TicketRef from "./TicketRef.vue";
import { displayId } from "../../lib/ids.ts";
import { ID_TEXT, stageText } from "./stage.ts";

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

/** One field of the brief: a muted label over its value. */
const B_ITEM =
  "flex flex-col gap-1 [&>dt]:text-xs [&>dt]:font-medium [&>dt]:text-fg-subtle [&>dd]:m-0 [&>dd]:flex [&>dd]:flex-col [&>dd]:gap-1 [&>dd]:text-base [&>dd]:leading-[1.6] [&>dd]:wrap-anywhere [&_.mono]:text-xs";
</script>

<template>
  <div v-if="!view && !loaded" class="flex flex-col gap-4 px-1.5 pt-1"><Skeleton :lines="4" /></div>
  <p v-else-if="!view" class="px-3 py-10 text-center text-sm text-fg-subtle">{{ t("Ticket {id} not found", { id: ticketId ?? "" }) }}</p>
  <div v-else class="flex flex-col gap-4 px-1.5 pt-1">
    <div v-if="stage" class="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
      <StageGlyph :stage="stage" />
      <span :class="stageText(stage)">{{ STAGE_LABEL[stage] }}</span>
      <span :class="ID_TEXT">{{ displayId(view.ticket.id) }}</span>
      <span class="dim">·</span>
      <span>{{ t("Created {time}", { time: formatRelativeTime(view.ticket.createdAt, nowMs) }) }}</span>
      <template v-if="view.ticket.closedAt">
        <span class="dim">·</span>
        <span>{{ t("Closed {time}", { time: formatRelativeTime(view.ticket.closedAt, nowMs) }) }}</span>
      </template>
    </div>

    <dl class="m-0 flex flex-col gap-4">
      <div :class="B_ITEM">
        <dt>{{ t("Goal") }}</dt>
        <dd>
          <span>{{ view.ticket.goal || "—" }}</span>
        </dd>
      </div>

      <div v-if="view.ticket.inputs.length > 0" :class="B_ITEM">
        <dt>{{ t("Input") }}</dt>
        <dd>
          <span v-for="(input, index) in view.ticket.inputs" :key="index" class="mono">
            {{ input }}
          </span>
        </dd>
      </div>

      <div v-if="view.ticket.acceptance.length > 0" :class="B_ITEM">
        <dt>{{ t("Acceptance criteria") }}</dt>
        <dd>
          <ul class="m-0 flex list-none flex-col gap-1 p-0">
            <li v-for="(item, index) in view.ticket.acceptance" :key="index" class="flex gap-2 [&>.ico]:mt-1 [&>.ico]:text-fg-subtle">
              <Icon name="check" size="xs" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </dd>
      </div>

      <div v-if="view.ticket.output" :class="B_ITEM">
        <dt>{{ t("Artifacts") }}</dt>
        <dd>
          <span class="mono">{{ view.ticket.output }}</span>
        </dd>
      </div>

      <div v-if="view.ticket.deliverTo.length > 0" :class="B_ITEM">
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

      <div :class="B_ITEM">
        <dt>{{ t("Model") }}</dt>
        <dd>
          <span v-if="modelInfo.text" :class="modelInfo.mono ? 'mono' : 'muted'">
            {{ modelInfo.text }}
          </span>
          <span v-if="modelInfo.hint" class="hint">{{ modelInfo.hint }}</span>
        </dd>
      </div>

      <div v-if="view.ticket.closeNote" :class="B_ITEM">
        <dt>{{ t("Close note") }}</dt>
        <dd>
          <span>{{ view.ticket.closeNote }}</span>
        </dd>
      </div>
    </dl>

    <div v-if="sortedReports.length > 0" class="flex flex-col gap-2">
      <div class="text-xs font-semibold text-fg-muted">{{ t("Reports") }}</div>
      <div class="flex flex-col gap-2">
        <ReportCard
          v-for="report in sortedReports"
          :key="report.seq"
          :report="report"
          :now-ms="nowMs"
          full
        />
      </div>
    </div>
  </div>
</template>
