<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import type { GapItem } from "../conversation.ts";
import { t } from "../i18n.ts";
import type { TranscriptDisplayItem } from "../transcript-map.ts";
import AssistantMessage from "./AssistantMessage.vue";
import BashLine from "./BashLine.vue";
import DispatchLine from "./DispatchLine.vue";
import EditLine from "./EditLine.vue";
import EventNote from "./EventNote.vue";
import FailureLine from "./FailureLine.vue";
import Icon from "./Icon.vue";
import MessageActions from "./MessageActions.vue";
import ProcessLine from "./ProcessLine.vue";
import ReportCard from "./ReportCard.vue";
import ResetMark from "./ResetMark.vue";
import UserMessage from "./UserMessage.vue";

/**
 * One line of the conversation, whichever shape it takes. Also used by WorkedGroup so a folded
 * turn's lines draw exactly as they did in place.
 */
withDefaults(
  defineProps<{
    item: TranscriptDisplayItem;
    tickets?: readonly TicketView[];
    runningJobIds?: ReadonlySet<string>;
    loadingEarlier?: boolean;
    fillingGaps?: boolean;
    retry?: () => Promise<void>;
    loadEarlier?: () => Promise<void>;
    fillGap?: (gap: GapItem) => Promise<void>;
    /** The turn's last assistant message, which earns the action row. */
    turnFinal?: boolean;
    /** Part of the newest turn, where touch pointers keep actions visible. */
    latest?: boolean;
  }>(),
  {
    tickets: () => [],
    runningJobIds: () => new Set<string>(),
    loadingEarlier: false,
    fillingGaps: false,
    retry: undefined,
    loadEarlier: undefined,
    fillGap: undefined,
    turnFinal: false,
    latest: false,
  },
);

defineEmits<{
  "open-ticket": [ticketId: string];
  "open-detail": [];
  "open-job": [jobId: string];
}>();
</script>

<template>
  <button
    v-if="item.kind === 'more'"
    type="button"
    class="more-line"
    :disabled="loadingEarlier"
    @click="loadEarlier?.()"
  >
    {{ loadingEarlier ? t("Loading…") : t("Earlier messages") }}
  </button>
  <button
    v-else-if="item.kind === 'gap'"
    type="button"
    class="more-line"
    :disabled="fillingGaps"
    @click="fillGap?.(item.gap)"
  >
    {{ fillingGaps ? t("Filling in…") : t("Fill in missing history") }}
  </button>
  <ResetMark v-else-if="item.kind === 'reset'" :summary="item.summary" :at="item.at" />
  <button
    v-else-if="item.kind === 'opening'"
    type="button"
    class="note link"
    :title="t('The ticket\'s goal, inputs, acceptance criteria and project memory')"
    @click="$emit('open-detail')"
  >
    <Icon name="flag" size="xs" />
    <span>{{ t("Opening") }}</span>
  </button>
  <UserMessage
    v-else-if="item.kind === 'user'"
    :text="item.text"
    :at="item.at"
    :pending="item.pending"
    :latest="latest"
    :tickets="tickets"
    :data-outline-key="item.key"
    @open-ticket="$emit('open-ticket', $event)"
  />
  <div v-else-if="item.kind === 'qa'" class="u-wrap" :data-outline-key="item.key">
    <div class="msg-user">
      <div class="via">{{ item.question }}</div>
      {{ item.answer }}
    </div>
    <MessageActions :text="item.answer" :at="item.at" :latest="latest" />
  </div>
  <AssistantMessage
    v-else-if="item.kind === 'assistant'"
    :text="item.text"
    :streaming="item.streaming"
    :tickets="tickets"
    :actions="turnFinal && item.streaming !== true"
    :at="item.at"
    :latest="latest"
    @open-ticket="$emit('open-ticket', $event)"
  />
  <ProcessLine v-else-if="item.kind === 'tools'" :steps="item.steps" :live="item.live" />
  <EditLine
    v-else-if="item.kind === 'edit'"
    :action="item.action"
    :path="item.path"
    :status="item.status"
    :diff="item.diff"
    :added="item.added"
    :removed="item.removed"
    :error="item.error"
  />
  <BashLine
    v-else-if="item.kind === 'bash'"
    :command="item.command"
    :status="item.status"
    :output="item.output"
    :exit-code="item.exitCode"
    :ms="item.ms"
    :job-id="item.jobId"
    :at="item.at"
    :running-job-ids="runningJobIds"
    @open-job="$emit('open-job', $event)"
  />
  <ReportCard v-else-if="item.kind === 'report'" :report="item.report" />
  <DispatchLine
    v-else-if="item.kind === 'dispatch'"
    :actions="item.actions"
    :live="item.live"
    :tickets="tickets"
    @open-ticket="$emit('open-ticket', $event)"
  />
  <EventNote
    v-else-if="item.kind === 'event'"
    :event-kind="item.eventKind"
    :ticket-id="item.ticketId"
    :status="item.status"
    :text="item.text"
    :detail="item.detail"
    :tickets="tickets"
    @open-ticket="$emit('open-ticket', $event)"
  />
  <div v-else-if="item.kind === 'idle'" class="idle-mark">
    <span>{{ item.text }}</span>
  </div>
  <FailureLine v-else-if="item.kind === 'failure'" :text="item.text" :retry="retry" />
</template>
