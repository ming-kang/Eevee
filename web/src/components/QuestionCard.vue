<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import type { Question, QuestionId } from "@shared/contracts/index.ts";
import { computed, nextTick, ref, watch } from "vue";
import { onRovingKeydown } from "../focus.ts";
import { t } from "../i18n.ts";
import {
  formatAnswer,
  initialDraft,
  initialOtherFlags,
  isComplete,
  type QuestionItemView,
} from "../questions.ts";
import { useSubmit } from "../submit.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";
import TicketRef from "./TicketRef.vue";

const props = defineProps<{
  questions: readonly Question[];
  tickets?: readonly TicketView[];
  /** Jump to this question (e.g. clicked in a dispatch line); stays undefined in ordinary use. */
  focusId?: QuestionId;
  answer: (id: QuestionId, text: string, answers: readonly string[]) => Promise<void>;
}>();

const emit = defineEmits<{
  later: [];
  "open-ticket": [ticketId: string];
  "select-question": [questionId: QuestionId];
}>();

const index = ref(0);
const drafts = ref<Record<string, string[]>>({});
const others = ref<Record<string, boolean[]>>({});
const { busy, error, run } = useSubmit();

function ensureState(q: Question): void {
  if (!drafts.value[q.id]) {
    const initial = initialDraft(q);
    drafts.value[q.id] = initial;
    others.value[q.id] = initialOtherFlags(q, initial);
  }
}

watch(
  () => props.questions,
  (list) => {
    if (list.length === 0) {
      index.value = 0;
      return;
    }
    if (index.value >= list.length) index.value = 0;
    for (const q of list) ensureState(q);
  },
  { immediate: true },
);

watch(
  () => props.focusId,
  (id) => {
    if (id === undefined) return;
    const at = props.questions.findIndex((q) => q.id === id);
    if (at !== -1) index.value = at;
  },
  { immediate: true },
);

const current = computed<Question | undefined>(() => props.questions[index.value]);
const currentItems = computed<readonly QuestionItemView[]>(
  () => (current.value?.items ?? []) as readonly QuestionItemView[],
);
const currentDraft = computed<string[]>(() =>
  current.value ? (drafts.value[current.value.id] ?? []) : [],
);
const currentOther = computed<boolean[]>(() =>
  current.value ? (others.value[current.value.id] ?? []) : [],
);
const complete = computed(() => currentDraft.value.length > 0 && isComplete(currentDraft.value));

function selectOption(itemIndex: number, option: string): void {
  const q = current.value;
  if (!q) return;
  ensureState(q);
  const d = drafts.value[q.id];
  const o = others.value[q.id];
  if (!d || !o) return;
  d[itemIndex] = option;
  o[itemIndex] = false;
}

async function openOther(itemIndex: number): Promise<void> {
  const q = current.value;
  if (!q) return;
  ensureState(q);
  const d = drafts.value[q.id];
  const o = others.value[q.id];
  if (!d || !o) return;
  o[itemIndex] = true;
  if (q.items[itemIndex]?.options.includes(d[itemIndex] ?? "")) {
    d[itemIndex] = "";
  }
  await nextTick();
  const input = document.querySelector<HTMLInputElement>(
    `[data-q-other="${q.id}"][data-i="${itemIndex}"]`,
  );
  input?.focus();
}

/** The option that takes Tab focus in a radio group: the checked one, else the first. */
function rovingIndex(itemIndex: number, options: readonly string[]): number {
  if (currentOther.value[itemIndex]) return 0;
  return Math.max(0, options.indexOf(currentDraft.value[itemIndex] ?? ""));
}

function updateOther(itemIndex: number, value: string): void {
  const q = current.value;
  if (!q) return;
  ensureState(q);
  const d = drafts.value[q.id];
  if (d) d[itemIndex] = value;
}

function prev(): void {
  const total = props.questions.length;
  if (total <= 1) return;
  index.value = (index.value + total - 1) % total;
  const question = props.questions[index.value];
  if (question) emit("select-question", question.id);
}

function next(): void {
  const total = props.questions.length;
  if (total <= 1) return;
  index.value = (index.value + 1) % total;
  const question = props.questions[index.value];
  if (question) emit("select-question", question.id);
}

async function submit(): Promise<void> {
  const q = current.value;
  if (!q || !complete.value) return;
  const formatted = formatAnswer(q, currentDraft.value);
  const ok = await run(() => props.answer(q.id, formatted, currentDraft.value));
  if (ok) {
    delete drafts.value[q.id];
    delete others.value[q.id];
  }
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}
</script>

<template>
  <form v-if="current" class="qcard" @submit.prevent="submit">
    <div class="qcard-h">
      <StageGlyph stage="answer" />
      <span>
        <template v-if="current.ticketId">
          <TicketRef
            :ticket-id="current.ticketId"
            :tickets="tickets"
            @open-ticket="$emit('open-ticket', $event)"
          />
          {{ t("asks you") }}
        </template>
        <template v-else>{{ t("The Router asks you") }}</template>
      </span>
      <span class="spacer" />
      <span v-if="questions.length > 1" class="pager">
        <button type="button" :title="t('Previous')" :aria-label="t('Previous question')" @click="prev">
          <Icon name="chevL" size="xs" />
        </button>
        <span>{{ index + 1 }}/{{ questions.length }}</span>
        <button type="button" :title="t('Next')" :aria-label="t('Next question')" @click="next">
          <Icon name="chevR" size="xs" />
        </button>
      </span>
    </div>
    <div class="qbody">
      <div v-for="(item, i) in currentItems" :key="i" class="qitem">
        <div :id="`q-${current.id}-${i}`" class="qitem-t">
          <span v-if="currentItems.length > 1" class="n">{{ i + 1 }}.</span>
          <span>{{ item.text }}</span>
        </div>
        <div class="opts">
          <div
            v-if="item.options.length > 0"
            class="opts-group"
            role="radiogroup"
            :aria-labelledby="`q-${current.id}-${i}`"
            @keydown="
              onRovingKeydown($event, item.options, currentDraft[i] ?? '', (o) => selectOption(i, o))
            "
          >
            <button
              v-for="(option, oi) in item.options"
              :key="option"
              type="button"
              class="opt"
              role="radio"
              :aria-checked="!currentOther[i] && currentDraft[i] === option"
              :tabindex="rovingIndex(i, item.options) === oi ? 0 : -1"
              :class="{ on: !currentOther[i] && currentDraft[i] === option }"
              @click="selectOption(i, option)"
            >
              <span class="radio" />
              <span>{{ option }}</span>
              <span v-if="option === item.recommended" class="rec">{{ t("Recommended") }}</span>
            </button>
          </div>
          <input
            v-if="currentOther[i]"
            :value="currentDraft[i] ?? ''"
            class="opt-input"
            :data-q-other="current.id"
            :data-i="i"
            :placeholder="t('Write your answer')"
            :aria-label="item.options.length > 0 ? t('Other answer') : item.text"
            @input="updateOther(i, ($event.target as HTMLInputElement).value)"
            @keydown="onInputKeydown"
          />
          <button
            v-else
            type="button"
            class="opt-more"
            @click="openOther(i)"
          >
            {{ t("Other…") }}
          </button>
        </div>
        <div
          v-if="item.why && !currentOther[i] && currentDraft[i] === item.recommended"
          class="why"
        >
          {{ item.why }}
        </div>
      </div>
    </div>
    <div class="qfoot">
      <span v-if="error" class="composer-error" role="alert">{{ error }}</span>
      <span class="spacer" />
      <button
        type="button"
        class="btn ghost sm"
        :title="current.ticketId ? t('Set aside and message the Worker') : t('Set aside and message the Router')"
        @click="$emit('later')"
      >
        {{ t("Later") }}
      </button>
      <button type="submit" class="btn primary sm" :disabled="busy || !complete">{{ t("Submit") }}</button>
    </div>
  </form>
</template>
