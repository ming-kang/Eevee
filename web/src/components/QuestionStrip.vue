<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import type { Question, QuestionId } from "@shared/contracts/index.ts";
import { computed } from "vue";
import { t } from "../i18n.ts";
import { formatAnswer } from "../questions.ts";
import { useSubmit } from "../submit.ts";
import Icon from "./Icon.vue";
import TicketRef from "./TicketRef.vue";

const props = defineProps<{
  /** The first open question; the strip leads with its first item. */
  question: Question;
  /** All open questions, for the "+N" tail. */
  count: number;
  tickets?: readonly TicketView[];
  answer: (id: QuestionId, text: string, answers: readonly string[]) => Promise<void>;
}>();

const emit = defineEmits<{
  expand: [];
  "open-ticket": [ticketId: string];
}>();

const { busy, run } = useSubmit();

/** A lone item with options can be answered right from the strip. */
const quick = computed(() => {
  const [item] = props.question.items;
  return props.question.items.length === 1 && item !== undefined && item.options.length > 0
    ? item
    : undefined;
});

function pick(option: string): void {
  const draft = [option];
  void run(() => props.answer(props.question.id, formatAnswer(props.question, draft), draft));
}
</script>

<template>
  <div class="qstrip">
    <span class="dot user" />
    <span class="qstrip-asker">
      <TicketRef
        v-if="question.ticketId"
        :ticket-id="question.ticketId"
        :tickets="tickets"
        @open-ticket="emit('open-ticket', $event)"
      />
      <template v-else>{{ t("The Router") }}</template>
    </span>
    <button type="button" class="qstrip-main" @click="$emit('expand')">
      <span class="qstrip-sep">·</span>
      <span class="ellipsis">{{ question.items[0]?.text ?? "" }}</span>
      <span v-if="count > 1" class="qmore">+{{ count - 1 }}</span>
    </button>
    <template v-if="quick">
      <button
        v-for="option in quick.options"
        :key="option"
        type="button"
        class="opt sm"
        :disabled="busy"
        @click="pick(option)"
      >
        {{ option }}
        <span v-if="option === quick.recommended" class="rec-dot" :title="t('Recommended')" />
      </button>
    </template>
    <span class="spacer" />
    <button
      type="button"
      class="btn ghost sm icon"
      :title="t('Answer now')"
      :aria-label="t('Answer now')"
      @click="$emit('expand')"
    >
      <Icon name="chevU" size="sm" />
    </button>
  </div>
</template>
