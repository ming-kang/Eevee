<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { BoardView, ProjectSummary } from "@shared/api/contract.ts";
import type { QuestionId } from "@shared/contracts/index.ts";
import { computed, ref, watch } from "vue";
import { countPendingQuestions, groupTickets, type RailTab } from "../board.ts";
import { provideComposerInsert } from "../composer-bridge.ts";
import type { ConversationWatch } from "../engine-data.ts";
import { errorText } from "../errors.ts";
import { t } from "../i18n.ts";
import { useSubmit } from "../submit.ts";
import { showToast } from "../toasts.ts";
import { mapTranscript, type QueuedMessage, queuedMessages } from "../transcript-map.ts";
import Composer from "./Composer.vue";
import Icon from "./Icon.vue";
import QuestionCard from "./QuestionCard.vue";
import QuestionReview from "./QuestionReview.vue";
import QuestionStrip from "./QuestionStrip.vue";
import QueuedDock from "./QueuedDock.vue";
import RailToggle from "./RailToggle.vue";
import RouterModel from "./RouterModel.vue";
import Skeleton from "./Skeleton.vue";
import Transcript from "./Transcript.vue";

const props = defineProps<{
  client: Client;
  project: ProjectSummary;
  board: BoardView | undefined;
  conversation: ConversationWatch;
  railCollapsed: boolean;
  railShortcut: string;
}>();

defineEmits<{
  "open-side": [];
  "open-rail": [tab?: RailTab];
  "open-ticket": [ticketId: string];
  "project-changed": [];
}>();

const params = computed(() => ({ project: props.project.id }));
const conversation = props.conversation;
const bridge = provideComposerInsert();

const displayItems = computed(() =>
  mapTranscript(conversation.view.value?.items ?? [], {
    mode: "router",
    live: conversation.live.value,
  }),
);

const questions = computed(() => props.board?.openQuestions ?? []);
const ticketGroups = computed(() => groupTickets(props.board?.tickets ?? []));
const pendingQuestions = computed(() => countPendingQuestions(props.board));
/** Status marks under the rail toggle; the outline dock shifts clear of their stack. */
const railMarkCount = computed(
  () =>
    (pendingQuestions.value > 0 ? 1 : 0) +
    (ticketGroups.value.review.length > 0 ? 1 : 0) +
    (ticketGroups.value.blocked.length > 0 ? 1 : 0),
);
const queued = computed(() => queuedMessages(conversation.inbox.value));
const queuedBusy = ref(new Set<string>());
/** An answered or withdrawn question opened from the transcript. */
const reviewId = ref<QuestionId>();
/** The open question the card should jump to. */
const focusId = ref<QuestionId>();
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
  await props.client.call("POST /api/projects/:project/conversation/retry", params.value);
}

async function send(text: string): Promise<void> {
  await props.client.call("POST /api/projects/:project/messages", params.value, { text });
}

/** Interrupting withdraws queued inputs too; their text comes back into the composer, oldest first. */
async function interrupt(): Promise<void> {
  const pending = queued.value;
  await props.client.call("POST /api/projects/:project/interrupt", params.value);
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
}

function openQuestion(id: QuestionId): void {
  if (questions.value.some((q) => q.id === id)) {
    later.value = false;
    reviewId.value = undefined;
    focusId.value = id;
    return;
  }
  reviewId.value = id;
}

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
      await props.client.call("POST /api/projects/:project/queue/:submission/withdraw", {
        ...params.value,
        submission: message.id,
      });
    },
    () => bridge.insert(message.text, "start"),
  );
}

function queueWithdraw(message: QueuedMessage): Promise<void> {
  return queueAction(message, async () => {
    await props.client.call("POST /api/projects/:project/queue/:submission/withdraw", {
      ...params.value,
      submission: message.id,
    });
  });
}
</script>

<template>
  <section
    class="chat-page"
    :class="{ landing: empty }"
    :style="{ '--ev-rail-marks': railMarkCount }"
  >
    <header class="header">
      <button type="button" class="btn ghost sm icon menu-btn" :aria-label="t('Menu')" @click="$emit('open-side')">
        <Icon name="menu" size="sm" />
      </button>
      <h1 v-if="!empty" class="ellipsis" :title="project.workspace">{{ project.title }}</h1>
      <span class="spacer" />
      <RailToggle
        :closed="railCollapsed"
        :shortcut="railShortcut"
        :questions="pendingQuestions"
        :review="ticketGroups.review.length"
        :blocked="ticketGroups.blocked.length"
        @open="$emit('open-rail', 'tickets')"
      />
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

    <div class="dock">
      <div class="dock-inner">
        <p v-if="conversation.error.value || interrupting.error.value" class="composer-error" role="alert">
          {{ conversation.error.value ?? interrupting.error.value }}
        </p>
        <QuestionReview
          v-if="reviewId !== undefined"
          :client="client"
          :project="project.id"
          :question="reviewId"
          :tickets="board?.tickets"
          @close="reviewId = undefined"
          @open-ticket="$emit('open-ticket', $event)"
        />
        <QuestionCard
          v-else-if="questions.length > 0 && !later"
          :questions="questions"
          :tickets="board?.tickets"
          :focus-id="focusId"
          :answer="answer"
          @later="later = true"
          @open-ticket="$emit('open-ticket', $event)"
        />
        <template v-else>
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
                class="stop"
                :disabled="interrupting.busy.value"
                :title="t('Interrupt this turn')"
                :aria-label="t('Interrupt this turn')"
                @click="interrupting.run(interrupt)"
              >
                <Icon name="stop" size="sm" />
              </button>
            </template>
          </Composer>
        </template>
      </div>
    </div>
  </section>
</template>
