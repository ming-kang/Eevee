<script setup lang="ts">
import type { TicketView } from "@shared/protocol/contract.ts";
import type { QuestionId } from "@shared/domain/index.ts";
import { computed } from "vue";
import type { GapItem } from "../../lib/conversation.ts";
import { t } from "../../lib/i18n.ts";
import { splitFormattedAnswer } from "../../lib/questions.ts";
import type { TranscriptDisplayItem } from "../../lib/transcript-map.ts";
import AssistantMessage from "./AssistantMessage.vue";
import BashLine from "./BashLine.vue";
import DispatchLine from "./DispatchLine.vue";
import EditLine from "./EditLine.vue";
import EventNote from "./EventNote.vue";
import FailureLine from "./FailureLine.vue";
import Icon from "../../ui/Icon.vue";
import MessageActions from "./MessageActions.vue";
import ProcessLine from "./ProcessLine.vue";
import ReportCard from "../project/ReportCard.vue";
import ResetMark from "./ResetMark.vue";
import ThinkingLine from "./ThinkingLine.vue";
import UserMessage from "./UserMessage.vue";
import { msgUser, uWrap, VIA } from "./message.ts";

/**
 * One line of the conversation, whichever shape it takes. Also used by WorkedGroup so a folded
 * turn's lines draw exactly as they did in place.
 */
const props = withDefaults(
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
    /** The conversation's fold-memory scope: persisted open/closed choices key off it. */
    foldScope?: string;
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
    foldScope: "",
  },
);

const emit = defineEmits<{
  "open-ticket": [ticketId: string];
  "open-detail": [];
  "open-job": [jobId: string];
  "open-question": [questionId: QuestionId];
}>();

/** Multi-item QA answers split per item, only when the text still matches the formatter's shape. */
const qaParts = computed(() => {
  if (props.item.kind !== "qa" || props.item.items === undefined) return undefined;
  return splitFormattedAnswer(props.item.items.map((text) => ({ text })), props.item.answer);
});

function openQuestionReview(): void {
  if (props.item.kind === "qa" && props.item.questionId !== undefined) {
    emit("open-question", props.item.questionId);
  }
}

/** A real text selection means the reader is quoting the bubble, not opening the review. */
function onQaClick(): void {
  const selection = window.getSelection();
  if (selection !== null && !selection.isCollapsed) return;
  openQuestionReview();
}
</script>

<template>
  <button
    v-if="item.kind === 'more'"
    type="button"
    class="self-center rounded-sm px-2 py-1 text-xs text-fg-subtle transition-colors enabled:hover:bg-hover enabled:hover:text-fg"
    :disabled="loadingEarlier"
    @click="loadEarlier?.()"
  >
    {{ loadingEarlier ? t("Loading…") : t("Earlier messages") }}
  </button>
  <button
    v-else-if="item.kind === 'gap'"
    type="button"
    class="self-center rounded-sm px-2 py-1 text-xs text-fg-subtle transition-colors enabled:hover:bg-hover enabled:hover:text-fg"
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
  <div v-else-if="item.kind === 'qa'" :class="uWrap()" :data-outline-key="item.key">
    <div
      :class="[msgUser(), { 'cursor-pointer focus-visible:shadow-(--ev-ring-in) focus-visible:outline-none': item.questionId !== undefined }]"
      :role="item.questionId !== undefined ? 'button' : undefined"
      :tabindex="item.questionId !== undefined ? 0 : undefined"
      :title="item.questionId !== undefined ? t('Review this question') : undefined"
      @click="onQaClick"
      @keydown.enter.prevent="openQuestionReview"
      @keydown.space.prevent="openQuestionReview"
    >
      <template v-if="item.items !== undefined && qaParts !== undefined">
        <div v-for="(part, i) in qaParts" :key="i" class="not-first:mt-2">
          <div :class="VIA">{{ item.items[i] }}</div>
          {{ part }}
        </div>
      </template>
      <template v-else-if="item.items !== undefined && item.items.length > 1">
        <div v-for="(text, i) in item.items" :key="i" :class="VIA">{{ text }}</div>
        {{ item.answer }}
      </template>
      <template v-else>
        <div :class="VIA">{{ item.question }}</div>
        {{ item.answer }}
      </template>
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
  <ThinkingLine
    v-else-if="item.kind === 'thinking'"
    :item="item"
    :fold-id="`${foldScope}|${item.key}`"
  />
  <EditLine
    v-else-if="item.kind === 'edit'"
    :action="item.action"
    :path="item.path"
    :status="item.status"
    :diff="item.diff"
    :added="item.added"
    :removed="item.removed"
    :error="item.error"
    :data-edit-key="item.key"
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
    @open-question="$emit('open-question', $event)"
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
  <div v-else-if="item.kind === 'idle'" class="self-center px-2 py-1 text-xs text-fg-subtle">
    <span>{{ item.text }}</span>
  </div>
  <FailureLine v-else-if="item.kind === 'failure'" :text="item.text" :retry="retry" />
</template>
