<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { BoardView, ProjectSummary } from "@shared/api/contract.ts";
import { computed, type ShallowRef } from "vue";
import type { RailTab } from "../board.ts";
import type { ConversationWatch } from "../engine-data.ts";
import type { StreamClient } from "../stream.ts";
import ChatPage from "./ChatPage.vue";
import WorkerView from "./WorkerView.vue";

const props = defineProps<{
  client: Client;
  stream: ShallowRef<StreamClient | undefined>;
  project: ProjectSummary;
  board: BoardView | undefined;
  routerConversation: ConversationWatch;
  ticketId?: string;
}>();

defineEmits<{
  "open-rail": [tab?: RailTab, jobId?: string];
  "open-ticket": [ticketId: string];
  "close-ticket": [];
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
    @open-ticket="$emit('open-ticket', $event)"
    @project-changed="$emit('project-changed')"
  />
</template>
