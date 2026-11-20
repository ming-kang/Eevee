<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import type { ReportStatus } from "@shared/contracts/index.ts";
import { computed } from "vue";
import type { VisualStage } from "../board.ts";
import { t } from "../i18n.ts";
import type { IconName } from "../icons.ts";
import { REPORT_LABEL } from "../labels.ts";
import type { EventKind } from "../transcript-map.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";
import TicketRef from "./TicketRef.vue";

const props = defineProps<{
  eventKind: EventKind;
  ticketId?: string;
  status?: ReportStatus;
  text: string;
  /** Long content (an answer, a job's output tail, a handed-over report), folded under the line. */
  detail?: string;
  tickets?: readonly TicketView[];
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const ICON: Record<EventKind, IconName> = {
  report: "flag",
  answer: "help",
  intervene: "user",
  deliver: "bell",
  job: "bell",
  notice: "bell",
};

const glyph = computed<{ stage: VisualStage } | { icon: IconName }>(() => {
  if (props.eventKind === "report" && (props.status === "blocked" || props.status === "failed")) {
    return { stage: "blocked" };
  }
  if (props.eventKind === "job") return { stage: "jobs" };
  return { icon: ICON[props.eventKind] };
});
</script>

<template>
  <details v-if="detail" class="proc">
    <summary>
      <StageGlyph v-if="'stage' in glyph" :stage="glyph.stage" />
      <Icon v-else :name="glyph.icon" size="xs" />
      <span class="ellipsis">{{ text }}</span>
      <Icon name="chevR" size="xs" class="chev" />
    </summary>
    <pre class="step-out">{{ detail }}</pre>
  </details>
  <div v-else class="note">
    <StageGlyph v-if="'stage' in glyph" :stage="glyph.stage" />
    <Icon v-else :name="glyph.icon" size="xs" />
    <span>
      <template v-if="eventKind === 'report' && ticketId && status">
        <TicketRef
          :ticket-id="ticketId"
          :tickets="tickets"
          @open-ticket="$emit('open-ticket', $event)"
        />
        {{ t("reported back ({status}): {text}", { status: REPORT_LABEL[status], text }) }}
      </template>
      <span v-else class="pre-wrap">{{ text }}</span>
    </span>
  </div>
</template>
