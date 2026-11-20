<script setup lang="ts">
import type { TicketView } from "@shared/protocol/contract.ts";
import type { Question, QuestionId } from "@shared/domain/index.ts";
import { computed } from "vue";
import { t } from "../../lib/i18n.ts";
import { formatAnswer } from "../../lib/questions.ts";
import { useSubmit } from "../../composables/submit.ts";
import Icon from "../../ui/Icon.vue";
import StageGlyph from "../project/StageGlyph.vue";
import TicketRef from "../project/TicketRef.vue";
import Button from "../../ui/Button.vue";

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
  <div class="flex min-h-10 animate-[ev-fade_var(--ev-regular)_var(--ev-ease)] flex-wrap items-center gap-x-2 gap-y-1 rounded-t-panel border-b border-separator bg-surface-2/50 py-1 pr-3 pl-4 text-left text-sm text-fg-muted [&>.glyph]:text-warning-fg">
    <StageGlyph stage="answer" />
    <span class="flex min-w-0 flex-none items-center">
      <TicketRef
        v-if="question.ticketId"
        :ticket-id="question.ticketId"
        :tickets="tickets"
        @open-ticket="emit('open-ticket', $event)"
      />
      <template v-else>{{ t("The Router") }}</template>
    </span>
    <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm text-fg-muted hover:text-fg" @click="$emit('expand')">
      <span class="opacity-60">·</span>
      <span class="ellipsis">{{ question.items[0]?.text ?? "" }}</span>
      <span v-if="count > 1" class="flex-none text-xs opacity-70">+{{ count - 1 }}</span>
    </button>
    <div v-if="quick" class="order-last flex w-full min-w-0 gap-2 pb-1">
      <button
        v-for="option in quick.options"
        :key="option"
        type="button"
        class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm bg-surface px-2 text-left text-xs leading-[1.43] transition-colors hover:bg-hover focus-visible:shadow-(--ring-inset) disabled:cursor-default disabled:opacity-55"
        :title="option"
        :disabled="busy"
        @click="pick(option)"
      >
        <span class="ellipsis">{{ option }}</span>
        <span v-if="option === quick.recommended" class="size-1.5 flex-none rounded-full bg-(--ev-user)" :title="t('Recommended')" />
      </button>
    </div>
    <Button variant="ghost" size="sm" icon :title="t('Answer now')" :aria-label="t('Answer now')" @click="$emit('expand')">
      <Icon name="chevU" size="sm" />
    </Button>
  </div>
</template>
