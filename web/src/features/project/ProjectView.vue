<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { BoardView, ProjectSummary } from "@shared/protocol/contract.ts";
import type { QuestionId } from "@shared/domain/index.ts";
import { computed, type ShallowRef } from "vue";
import type { RailTab } from "../../lib/board.ts";
import type { ConversationWatch } from "../../composables/engine-data.ts";
import type { StreamClient } from "../../lib/stream.ts";
import ChatPage from "../conversation/ChatPage.vue";
import WorkerView from "./WorkerView.vue";

const props = defineProps<{
  client: Client;
  stream: ShallowRef<StreamClient | undefined>;
  project: ProjectSummary;
  board: BoardView | undefined;
  routerConversation: ConversationWatch;
  ticketId?: string;
  questionId?: QuestionId;
}>();

defineEmits<{
  "open-rail": [tab?: RailTab, jobId?: string];
  "open-ticket": [ticketId: string];
  "close-ticket": [];
  "question-route": [questionId: QuestionId | undefined];
  "project-changed": [];
}>();

const selectedView = computed(() =>
  props.board?.tickets.find((t) => t.ticket.id === props.ticketId),
);
</script>

<template>
  <WorkerView
    v-if="ticketId"
    :key="ticketId"
    :client="client"
    :stream="stream"
    :project="project.id"
    :project-title="project.title"
    :ticket-id="ticketId"
    :view="selectedView"
    :tickets="board?.tickets"
    :open-questions="board?.openQuestions"
    :board-loaded="board !== undefined"
    @close="$emit('close-ticket')"
    @open-rail="(tab, jobId) => $emit('open-rail', tab, jobId)"
    @open-ticket="$emit('open-ticket', $event)"
  />
  <ChatPage
    v-else
    :client="client"
    :project="project"
    :board="board"
    :conversation="routerConversation"
    :question-id="questionId"
    @question-route="$emit('question-route', $event)"
    @open-ticket="$emit('open-ticket', $event)"
    @project-changed="$emit('project-changed')"
  />
</template>
