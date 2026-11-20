<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { BoardView, ProjectSummary } from "@shared/protocol/contract.ts";
import type { QuestionId } from "@shared/domain/index.ts";
import { computed, ref, watch } from "vue";
import { provideComposerInsert } from "../../composables/composer-bridge.ts";
import type { ConversationWatch } from "../../composables/engine-data.ts";
import { errorText } from "../../lib/errors.ts";
import { t } from "../../lib/i18n.ts";
import { useQuestionNavigation } from "../../composables/question-navigation.ts";
import { useSubmit } from "../../composables/submit.ts";
import { showToast } from "../../composables/toasts.ts";
import { mapTranscript, type QueuedMessage, queuedMessages } from "../../lib/transcript-map.ts";
import BrandLogo from "../../ui/BrandLogo.vue";
import Composer from "./Composer.vue";
import Icon from "../../ui/Icon.vue";
import QuestionCard from "./QuestionCard.vue";
import QuestionReview from "./QuestionReview.vue";
import QuestionStrip from "./QuestionStrip.vue";
import QueuedDock from "./QueuedDock.vue";
import RouterModel from "../settings/RouterModel.vue";
import Skeleton from "../../ui/Skeleton.vue";
import Transcript from "./Transcript.vue";
import { STOP } from "./composer.ts";
import { COMPOSER_STACK, DOCK, DOCK_INNER } from "./dock.ts";
import { ERROR_TEXT } from "../../ui/surface.ts";

const props = defineProps<{
  client: Client;
  project: ProjectSummary;
  board: BoardView | undefined;
  conversation: ConversationWatch;
  questionId?: QuestionId;
}>();

const emit = defineEmits<{
  "open-ticket": [ticketId: string];
  "question-route": [questionId: QuestionId | undefined];
  "project-changed": [];
}>();

const params = computed(() => ({ project: props.project.id, conversation: "router" }));
const conversation = props.conversation;
const bridge = provideComposerInsert();

const displayItems = computed(() =>
  mapTranscript(conversation.view.value?.items ?? [], {
    mode: "router",
    live: conversation.live.value,
  }),
);

const questions = computed(() => props.board?.openQuestions ?? []);
const queued = computed(() => queuedMessages(conversation.inbox.value));
const queuedBusy = ref(new Set<string>());
const { reviewId, focusId, open, close: closeQuestion, answered } = useQuestionNavigation(
  () => props.questionId,
  () => props.board?.openQuestions,
  (id) => emit("question-route", id),
);
const interrupting = useSubmit();
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
  await props.client.call("POST /api/projects/:project/conversations/:conversation/retry", params.value);
}

async function send(text: string): Promise<void> {
  await props.client.call("POST /api/projects/:project/conversations/:conversation/messages", params.value, { text });
}

/** Interrupting withdraws queued inputs too; their text comes back into the composer, oldest first. */
async function interrupt(): Promise<void> {
  const pending = queued.value;
  await props.client.call("POST /api/projects/:project/conversations/:conversation/interrupt", params.value);
  if (pending.length > 0) {
    bridge.insert(
      pending.map((message) => message.text).join("\n\n"),
      "start",
    );
  }
}

async function answer(id: QuestionId, text: string, answers: readonly string[]): Promise<void> {
  await props.client.call(
    "POST /api/projects/:project/questions/:question/answer",
    { ...params.value, question: id },
    { answer: text, answers: [...answers] },
  );
  answered(id);
}

function openQuestion(id: QuestionId): void {
  later.value = false;
  open(id);
}

function setAsideQuestion(): void {
  closeQuestion();
  later.value = true;
}

watch(
  () => props.questionId,
  (id) => {
    if (id !== undefined) later.value = false;
  },
);

async function queueAction(
  message: QueuedMessage,
  fn: () => Promise<void>,
  after?: () => void,
): Promise<void> {
  const next = new Set(queuedBusy.value);
  next.add(message.id);
  queuedBusy.value = next;
  try {
    await fn();
    after?.();
  } catch (cause) {
    showToast(errorText(cause), "error");
  } finally {
    const done = new Set(queuedBusy.value);
    done.delete(message.id);
    queuedBusy.value = done;
  }
}

function queueEdit(message: QueuedMessage): Promise<void> {
  return queueAction(
    message,
    async () => {
      await props.client.call("DELETE /api/projects/:project/conversations/:conversation/queue/:submission", {
        ...params.value,
        submission: message.id,
      });
    },
    () => bridge.insert(message.text, "start"),
  );
}

function queueWithdraw(message: QueuedMessage): Promise<void> {
  return queueAction(message, async () => {
    await props.client.call("DELETE /api/projects/:project/conversations/:conversation/queue/:submission", {
      ...params.value,
      submission: message.id,
    });
  });
}
</script>

<template>
  <section class="chat-page" :class="{ landing: empty }">
    <header class="header">
      <div v-if="!empty" class="header-title">
        <Icon name="folderOpen" size="sm" class="dim hide-sm" />
        <h1 class="ellipsis" :title="project.workspace">{{ project.title }}</h1>
      </div>
      <span class="spacer" />
    </header>

    <div v-if="empty" class="mt-auto flex animate-[ev-rise_var(--ev-slow)_var(--ev-ease)] flex-col items-center gap-1.5 px-(--ev-gutter) pb-5.5 text-center">
      <BrandLogo class="mb-1 size-8" />
      <h2 class="text-(length:--ev-display) leading-[1.3] font-semibold tracking-[-0.02em]" :title="project.workspace">{{ project.title }}</h2>
      <p class="mono ellipsis max-w-[min(100%,calc(480px*var(--ev-scale)))] text-xs text-fg-subtle">{{ project.workspace }}</p>
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
      :running="conversation.running.value"
      :fold-scope="`r:${project.id}`"
      :loading-earlier="conversation.loadingEarlier.value"
      :filling-gaps="conversation.fillingGaps.value"
      :retry="retry"
      :load-earlier="conversation.loadEarlier"
      :fill-gap="conversation.fillGap"
      @open-ticket="$emit('open-ticket', $event)"
      @open-question="openQuestion"
    />

    <div class="dock" :class="DOCK">
      <div :class="DOCK_INNER">
        <p v-if="conversation.error.value || interrupting.error.value" :class="ERROR_TEXT" role="alert">
          {{ conversation.error.value ?? interrupting.error.value }}
        </p>
        <QuestionReview
          v-if="reviewId !== undefined"
          :client="client"
          :project="project.id"
          :question="reviewId"
          :tickets="board?.tickets"
          @close="closeQuestion"
          @open-ticket="$emit('open-ticket', $event)"
        />
        <QuestionCard
          v-else-if="questions.length > 0 && !later"
          :questions="questions"
          :tickets="board?.tickets"
          :focus-id="focusId"
          :answer="answer"
          @select-question="openQuestion"
          @later="setAsideQuestion"
          @open-ticket="$emit('open-ticket', $event)"
        />
        <div
          v-else
          :class="[COMPOSER_STACK, { 'has-seam': questions.length > 0 || queued.length > 0 }]"
        >
          <QuestionStrip
            v-if="questions.length > 0"
            :question="questions[0]!"
            :count="questions.length"
            :tickets="board?.tickets"
            :answer="answer"
            @expand="later = false"
            @open-ticket="$emit('open-ticket', $event)"
          />
          <QueuedDock
            :messages="queued"
            :busy="queuedBusy"
            @edit="queueEdit"
            @withdraw="queueWithdraw"
          />
          <Composer
            :draft-key="`r:${project.id}`"
            :send="send"
            :stop="conversation.running.value ? () => interrupting.run(interrupt) : undefined"
            :tickets="board?.tickets ?? []"
            :placeholder="conversation.running.value ? t('Add a message') : t('Tell the Router what to do')"
          >
            <template #actions>
              <RouterModel :client="client" :project="project" @changed="$emit('project-changed')" />
            </template>
            <template v-if="conversation.running.value" #end>
              <button
                type="button"
                :class="STOP"
                :disabled="interrupting.busy.value"
                :title="t('Interrupt this turn')"
                :aria-label="t('Interrupt this turn')"
                @click="interrupting.run(interrupt)"
              >
                <Icon name="stop" size="sm" />
              </button>
            </template>
          </Composer>
        </div>
      </div>
    </div>
  </section>
</template>
