<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { BoardView, ProjectSummary } from "@shared/api/contract.ts";
import type { QuestionId } from "@shared/contracts/index.ts";
import { computed, ref, watch } from "vue";
import type { RailTab } from "../board.ts";
import type { ConversationWatch } from "../engine-data.ts";
import { t } from "../i18n.ts";
import { mapTranscript } from "../transcript-map.ts";
import Composer from "./Composer.vue";
import Icon from "./Icon.vue";
import QuestionCard from "./QuestionCard.vue";
import QuestionStrip from "./QuestionStrip.vue";
import RouterModel from "./RouterModel.vue";
import Skeleton from "./Skeleton.vue";
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
  "project-changed": [];
}>();

const params = computed(() => ({ project: props.project.id }));
const conversation = props.conversation;

const displayItems = computed(() =>
  mapTranscript(conversation.view.value?.items ?? [], {
    mode: "router",
    live: conversation.live.value,
    inbox: conversation.inbox.value,
  }),
);

const questions = computed(() => props.board?.openQuestions ?? []);
/** A loaded conversation with nothing in it: the title and the composer stand together in the middle. */
const empty = computed(
  () => conversation.view.value !== undefined && displayItems.value.length === 0,
);
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
  <section class="chat-page" :class="{ landing: empty }">
    <header class="header">
      <button type="button" class="btn ghost sm icon menu-btn" :aria-label="t('Menu')" @click="$emit('open-side')">
        <Icon name="menu" size="sm" />
      </button>
      <h1 v-if="!empty" class="ellipsis" :title="project.workspace">{{ project.title }}</h1>
      <span class="spacer" />
      <button type="button" class="btn ghost sm rail-btn" @click="$emit('open-rail', 'tickets')">
        <span>{{ t("Tickets") }}</span>
        <span v-if="questions.length > 0" class="count user">{{ questions.length }}</span>
      </button>
    </header>

    <div v-if="empty" class="landing-hero">
      <h2 :title="project.workspace">{{ project.title }}</h2>
    </div>
    <div v-else-if="displayItems.length === 0" class="chat">
      <div class="chat-inner">
        <Skeleton :lines="5" />
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

    <div class="dock">
      <div class="dock-inner">
        <p v-if="conversation.error.value" class="composer-error" role="alert">
          {{ conversation.error.value }}
        </p>
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
            :placeholder="conversation.running.value ? t('Add a message') : t('Tell the Router what to do')"
          >
            <template #actions>
              <RouterModel :client="client" :project="project" @changed="$emit('project-changed')" />
            </template>
          </Composer>
        </template>
      </div>
    </div>
  </section>
</template>
