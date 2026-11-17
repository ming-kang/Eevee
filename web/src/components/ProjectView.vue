<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { ProjectSummary } from "@shared/api/contract.ts";
import type { QuestionId } from "@shared/contracts/index.ts";
import { computed, ref } from "vue";
import { usePolling } from "../polling.ts";
import BoardRail from "./BoardRail.vue";
import ChatView from "./ChatView.vue";
import Composer from "./Composer.vue";
import QuestionCard from "./QuestionCard.vue";
import WorkerView from "./WorkerView.vue";

const props = defineProps<{ client: Client; project: ProjectSummary }>();
const params = computed(() => ({ project: props.project.id }));

const board = usePolling(() => props.client.call("GET /api/projects/:project/board", params.value));
const conversation = usePolling(() =>
  props.client.call("GET /api/projects/:project/conversation", params.value),
);
const question = computed(() => board.data.value?.openQuestions[0]);
const selected = ref<string>();
const selectedView = computed(() =>
  board.data.value?.tickets.find((t) => t.ticket.id === selected.value),
);

async function retry(): Promise<void> {
  await props.client.call("POST /api/projects/:project/conversation/retry", params.value);
  await conversation.refresh();
}

async function send(text: string): Promise<void> {
  await props.client.call("POST /api/projects/:project/messages", params.value, { text });
  await conversation.refresh();
}

async function answer(id: QuestionId, text: string): Promise<void> {
  await props.client.call(
    "POST /api/projects/:project/questions/:question/answer",
    { ...params.value, question: id },
    { answer: text },
  );
  await Promise.all([board.refresh(), conversation.refresh()]);
}
</script>

<template>
  <div class="project">
    <WorkerView
      v-if="selected"
      :key="selected"
      :client="client"
      :project="project.id"
      :ticket-id="selected"
      :view="selectedView"
      @close="selected = undefined"
    />
    <section v-else class="main">
      <header class="header">
        <strong>{{ project.title }}</strong>
        <span class="muted path">{{ project.workspace }}</span>
      </header>
      <ChatView
        :lines="conversation.data.value?.lines ?? []"
        :running="conversation.data.value?.running ?? false"
        :failure="conversation.data.value?.failure"
        :retry="retry"
        empty="和 Router 说点什么吧。"
      />
      <p v-if="conversation.error.value" class="error status">{{ conversation.error.value }}</p>
      <div class="dock">
        <QuestionCard v-if="question" :key="question.id" :question="question" :answer="answer" />
        <Composer v-else :send="send" />
      </div>
    </section>
    <BoardRail
      :board="board.data.value"
      :error="board.error.value"
      :active="selected"
      @open="selected = $event"
    />
  </div>
</template>

<style scoped>
.project {
  display: grid;
  grid-template-columns: minmax(400px, 1fr) var(--ev-rail-width);
  min-height: 0;
  height: 100%;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.header {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 12px 24px;
  border-bottom: 1px solid var(--ev-border);
}

.path {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  padding: 0 24px;
}

.dock {
  padding: 12px 24px 20px;
}

@media (max-width: 1024px) {
  .project {
    grid-template-columns: minmax(0, 1fr);
  }
  .project > :last-child {
    display: none;
  }
}
</style>
