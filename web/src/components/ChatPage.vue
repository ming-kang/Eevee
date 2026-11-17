<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { BoardView, ProjectSummary } from "@shared/api/contract.ts";
import type { QuestionId } from "@shared/contracts/index.ts";
import { computed, ref, watch } from "vue";
import type { RailTab } from "../board.ts";
import type { ConversationWatch } from "../engine-data.ts";
import { mapTranscript } from "../transcript-map.ts";
import Composer from "./Composer.vue";
import Icon from "./Icon.vue";
import QuestionCard from "./QuestionCard.vue";
import QuestionStrip from "./QuestionStrip.vue";
import Transcript from "./Transcript.vue";

const props = defineProps<{
  client: Client;
  project: ProjectSummary;
  board: BoardView | undefined;
  conversation: ConversationWatch;
}>();

defineEmits<{
  "open-side": [];
  "open-rail": [tab?: RailTab];
  "open-ticket": [ticketId: string];
}>();

const params = computed(() => ({ project: props.project.id }));
const conversation = props.conversation;

const displayItems = computed(() =>
  mapTranscript(conversation.view.value?.items ?? [], {
    mode: "router",
    live: conversation.live.value,
  }),
);

const questions = computed(() => props.board?.openQuestions ?? []);
const later = ref(false);

watch(
  () => questions.value.length,
  (len) => {
    if (len === 0) later.value = false;
  },
);

async function retry(): Promise<void> {
  await props.client.call("POST /api/projects/:project/conversation/retry", params.value);
}

async function send(text: string): Promise<void> {
  await props.client.call("POST /api/projects/:project/messages", params.value, { text });
}

async function answer(id: QuestionId, text: string): Promise<void> {
  await props.client.call(
    "POST /api/projects/:project/questions/:question/answer",
    { ...params.value, question: id },
    { answer: text },
  );
}
</script>

<template>
  <section class="chat-page">
    <header class="header">
      <button type="button" class="btn ghost icon menu-btn" title="菜单" aria-label="菜单" @click="$emit('open-side')">
        <Icon name="menu" />
      </button>
      <h1 class="ellipsis" :title="project.workspace">{{ project.title }}</h1>
      <span class="spacer" />
      <button type="button" class="btn ghost sm rail-btn" @click="$emit('open-rail', 'tickets')">
        <span>工单</span>
        <span v-if="questions.length > 0" class="count user">{{ questions.length }}</span>
      </button>
    </header>

    <div v-if="displayItems.length === 0" class="chat">
      <div class="chat-inner" style="min-height: 100%">
        <div class="empty">
          <h3>{{ project.title }}</h3>
          <p>告诉 Router 你想做什么。它会把工作拆成工单在后台完成，只在需要你决定时来问你。</p>
        </div>
      </div>
    </div>
    <Transcript
      v-else
      :items="displayItems"
      :tickets="board?.tickets"
      :loading-earlier="conversation.loadingEarlier.value"
      :filling-gaps="conversation.fillingGaps.value"
      :retry="retry"
      :load-earlier="conversation.loadEarlier"
      :fill-gap="conversation.fillGap"
      @open-ticket="$emit('open-ticket', $event)"
    />

    <p v-if="conversation.error.value" class="error" style="margin: 0; padding: 0 24px 6px; font-size: 12px">
      {{ conversation.error.value }}
    </p>

    <div class="dock">
      <div class="dock-inner">
        <QuestionCard
          v-if="questions.length > 0 && !later"
          :questions="questions"
          :tickets="board?.tickets"
          :answer="answer"
          @later="later = true"
          @open-ticket="$emit('open-ticket', $event)"
        />
        <template v-else>
          <QuestionStrip
            v-if="questions.length > 0"
            :count="questions.length"
            @expand="later = false"
          />
          <Composer
            :draft-key="`r:${project.id}`"
            :send="send"
            :placeholder="
              conversation.running.value
                ? 'Router 正在工作，消息会在本批工具调用结束后被看到…'
                : '告诉 Router 你想做什么…'
            "
          />
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-page {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1;
}
</style>
