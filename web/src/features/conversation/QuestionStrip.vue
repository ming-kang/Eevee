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
  <div class="flex min-h-9.5 animate-[ev-fade_var(--ev-regular)_var(--ev-ease)] items-center gap-2 rounded-t-xl border-b border-separator bg-(--ev-user-film) py-1 pr-2.5 pl-4 text-left text-sm font-medium text-warning-fg transition-colors hover:bg-[color-mix(in_oklab,var(--ev-user)_18%,transparent)] [&_.ico]:text-warning-fg">
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
    <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-warning-fg" @click="$emit('expand')">
      <span class="opacity-60">·</span>
      <span class="ellipsis">{{ question.items[0]?.text ?? "" }}</span>
      <span v-if="count > 1" class="flex-none text-xs opacity-70">+{{ count - 1 }}</span>
    </button>
    <template v-if="quick">
      <button
        v-for="option in quick.options"
        :key="option"
        type="button"
        class="flex min-h-6.5 items-center gap-2.5 rounded-sm px-2 py-0.5 text-left text-xs leading-[1.43] font-medium transition-colors hover:bg-hover focus-visible:shadow-(--ring-inset) disabled:cursor-default disabled:opacity-55"
        :disabled="busy"
        @click="pick(option)"
      >
        {{ option }}
        <span v-if="option === quick.recommended" class="size-1.5 flex-none rounded-full bg-(--ev-user)" :title="t('Recommended')" />
      </button>
    </template>
    <span class="spacer" />
    <Button variant="ghost" size="sm" icon :title="t('Answer now')" :aria-label="t('Answer now')" @click="$emit('expand')">
      <Icon name="chevU" size="sm" />
    </Button>
  </div>
</template>
