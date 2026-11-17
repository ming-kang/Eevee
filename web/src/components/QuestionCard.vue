<script setup lang="ts">
import type { Question, QuestionId } from "@shared/contracts/index.ts";
import { computed, ref } from "vue";
import { formatAnswer, initialDraft, isComplete } from "../questions.ts";
import { useSubmit } from "../submit.ts";

const props = defineProps<{
  question: Question;
  answer: (id: QuestionId, text: string) => Promise<void>;
}>();
const draft = ref(initialDraft(props.question));
const complete = computed(() => isComplete(draft.value));
const { busy, error, run } = useSubmit();

async function submit(): Promise<void> {
  if (!complete.value) return;
  await run(() => props.answer(props.question.id, formatAnswer(props.question, draft.value)));
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}
</script>

<template>
  <form class="card" @submit.prevent="submit">
    <div class="head muted">
      {{ question.ticketId ? `${question.ticketId} 想问你` : "Router 想问你" }} · {{ question.id }}
    </div>
    <div v-for="(item, i) in question.items" :key="i" class="item">
      <div class="text">{{ item.text }}</div>
      <div v-if="item.options.length > 0" class="options">
        <button
          v-for="option in item.options"
          :key="option"
          type="button"
          :class="{ chosen: draft[i] === option }"
          @click="draft[i] = option"
        >
          {{ option }}<span v-if="option === item.recommended" class="muted">（推荐）</span>
        </button>
      </div>
      <textarea v-model="draft[i]" rows="1" placeholder="或者直接写答案…" @keydown="onKeydown" />
    </div>
    <div class="actions">
      <span v-if="error" class="error">{{ error }}</span>
      <button class="primary" type="submit" :disabled="busy || !complete">回答</button>
    </div>
  </form>
</template>

<style scoped>
.card {
  border: 1px solid var(--ev-accent);
  border-radius: var(--ev-radius);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.head {
  font-size: 12px;
}

.text {
  font-weight: 600;
  margin-bottom: 6px;
}

.options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.options .chosen {
  border-color: var(--ev-accent);
  color: var(--ev-accent);
}

textarea {
  width: 100%;
  border: 1px solid var(--ev-border);
  border-radius: 8px;
  padding: 6px 10px;
  background: transparent;
  resize: vertical;
}

.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
}
</style>
