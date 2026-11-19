<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { TicketView } from "@shared/api/contract.ts";
import type { Question, QuestionId, TicketId } from "@shared/contracts/index.ts";
import { computed, ref, type ShallowRef, watch } from "vue";
import { effectiveStage, groupTickets, type RailTab } from "../board.ts";
import { provideComposerInsert } from "../composer-bridge.ts";
import { useConversationWatch } from "../engine-data.ts";
import { errorText } from "../errors.ts";
import { t } from "../i18n.ts";
import { STAGE_LABEL } from "../labels.ts";
import { vSeg } from "../dom.ts";
import type { StreamClient } from "../stream.ts";
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
import StageGlyph from "./StageGlyph.vue";
import Skeleton from "./Skeleton.vue";
import Transcript from "./Transcript.vue";

const props = defineProps<{
  client: Client;
  stream: ShallowRef<StreamClient | undefined>;
  project: string;
  view: TicketView | undefined;
  tickets?: readonly TicketView[];
  openQuestions?: readonly Question[];
  boardLoaded?: boolean;
  ticketId: string;
  railCollapsed: boolean;
  railShortcut: string;
}>();

defineEmits<{
  close: [];
  "open-side": [];
  "open-rail": [tab?: RailTab, jobId?: string];
  "open-ticket": [ticketId: string];
}>();

const params = computed(() => ({ project: props.project, ticket: props.ticketId }));
const bridge = provideComposerInsert();
const conversation = useConversationWatch(props.stream, () => ({
  kind: "conversation",
  project: props.project,
  ticket: props.ticketId as TicketId,
}));

const displayItems = computed(() =>
  mapTranscript(conversation.view.value?.items ?? [], {
    mode: "worker",
    live: conversation.live.value,
    ticketId: props.ticketId as TicketId,
    reports: props.view?.reports,
  }),
);

/** Waiting on the first answer: neither the conversation nor a reason to show none has arrived. */
const loading = computed(
  () =>
    conversation.view.value === undefined &&
    conversation.error.value === undefined &&
    props.view?.stage !== "queued" &&
    (props.view !== undefined || !props.boardLoaded),
);

const runningJobIds = computed(
  () =>
    new Set(
      (props.view?.jobs ?? []).filter((j) => j.status === "running").map((j) => j.id),
    ),
);

const ticketQuestions = computed(() =>
  (props.openQuestions ?? []).filter(
    (q) => q.ticketId === props.ticketId && q.answer === undefined,
  ),
);

const stage = computed(() => (props.view ? effectiveStage(props.view) : undefined));
const ticketGroups = computed(() => groupTickets(props.tickets ?? []));
const pendingQuestions = computed(
  () => (props.openQuestions ?? []).filter((q) => q.answer === undefined).length,
);
/** Status marks under the rail toggle; the outline dock shifts clear of their stack. */
const railMarkCount = computed(
  () =>
    (pendingQuestions.value > 0 ? 1 : 0) +
    (ticketGroups.value.review.length > 0 ? 1 : 0) +
    (ticketGroups.value.blocked.length > 0 ? 1 : 0),
);
const mode = ref<"steer" | "followUp">("steer");
const open = computed(() => props.view?.ticket.status === "open");
const later = ref(false);
const interrupting = useSubmit();
const queued = computed(() => queuedMessages(conversation.inbox.value));
const queuedBusy = ref(new Set<string>());
/** An answered or withdrawn question opened from the transcript. */
const reviewId = ref<QuestionId>();
/** The open question the card should jump to. */
const focusId = ref<QuestionId>();

watch(
  [() => props.ticketId, () => ticketQuestions.value.length],
  ([, len]) => {
    if (len === 0) later.value = false;
  },
);

watch(
  () => props.ticketId,
  () => {
    later.value = false;
  },
);

async function send(text: string): Promise<void> {
  await props.client.call("POST /api/projects/:project/tickets/:ticket/messages", params.value, {
    text,
    mode: mode.value,
  });
}

/** Interrupting withdraws queued inputs too; their text comes back into the composer, oldest first. */
async function interrupt(): Promise<void> {
  const pending = queued.value;
  await props.client.call("POST /api/projects/:project/tickets/:ticket/interrupt", params.value);
  if (pending.length > 0) {
    bridge.insert(
      pending.map((message) => message.text).join("\n\n"),
      "start",
    );
  }
}

async function retry(): Promise<void> {
  await props.client.call("POST /api/projects/:project/tickets/:ticket/retry", params.value);
}

async function answer(id: QuestionId, text: string, answers: readonly string[]): Promise<void> {
  await props.client.call(
    "POST /api/projects/:project/questions/:question/answer",
    { project: props.project, question: id },
    { answer: text, answers: [...answers] },
  );
}

function openQuestion(id: QuestionId): void {
  if (ticketQuestions.value.some((q) => q.id === id)) {
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
      await props.client.call(
        "POST /api/projects/:project/tickets/:ticket/queue/:submission/withdraw",
        { ...params.value, submission: message.id },
      );
    },
    () => bridge.insert(message.text, "start"),
  );
}

function queueWithdraw(message: QueuedMessage): Promise<void> {
  return queueAction(message, async () => {
    await props.client.call(
      "POST /api/projects/:project/tickets/:ticket/queue/:submission/withdraw",
      { ...params.value, submission: message.id },
    );
  });
}

function queueSteer(message: QueuedMessage): Promise<void> {
  return queueAction(message, async () => {
    await props.client.call(
      "POST /api/projects/:project/tickets/:ticket/queue/:submission/steer",
      { ...params.value, submission: message.id },
    );
  });
}
</script>

<template>
  <section class="worker" :style="{ '--ev-rail-marks': railMarkCount }">
    <header class="header">
      <button type="button" class="btn ghost sm icon menu-btn" :aria-label="t('Menu')" @click="$emit('open-side')">
        <Icon name="menu" size="sm" />
      </button>
      <button
        type="button"
        class="btn ghost sm icon back-btn"
        :title="t('Back to the Router')"
        :aria-label="t('Back to the Router conversation')"
        @click="$emit('close')"
      >
        <Icon name="chevL" size="sm" />
      </button>
      <span class="t-id-h">{{ ticketId }}</span>
      <h1 class="ellipsis">
        {{ view ? view.ticket.title : boardLoaded ? t("Ticket {id} not found", { id: ticketId }) : "" }}
      </h1>
      <span
        v-if="view && stage"
        class="stage-h"
        :class="`s-${stage}`"
        :title="STAGE_LABEL[stage]"
      >
        <StageGlyph :stage="stage" />
        <span class="hide-sm">{{ STAGE_LABEL[stage] }}</span>
      </span>
      <span class="spacer" />
      <RailToggle
        :closed="railCollapsed"
        :shortcut="railShortcut"
        :questions="pendingQuestions"
        :review="ticketGroups.review.length"
        :blocked="ticketGroups.blocked.length"
        @open="$emit('open-rail', 'detail')"
      />
    </header>

    <div v-if="displayItems.length === 0 && loading" class="chat">
      <div class="chat-inner">
        <Skeleton :lines="5" />
      </div>
    </div>
    <div v-else-if="displayItems.length === 0" class="chat">
      <div class="empty">
        <p>
          {{
            !view && boardLoaded
              ? t("Ticket {id} not found", { id: ticketId })
              : view?.stage === "queued"
                ? t("Queued")
                : conversation.view.value
                  ? t("Not started yet")
                  : ""
          }}
        </p>
      </div>
    </div>
    <Transcript
      v-else
      :items="displayItems"
      :tickets="tickets"
      :running-job-ids="runningJobIds"
      :running="conversation.running.value"
      :fold-scope="`w:${project}:${ticketId}`"
      :loading-earlier="conversation.loadingEarlier.value"
      :filling-gaps="conversation.fillingGaps.value"
      :retry="open ? retry : undefined"
      :load-earlier="conversation.loadEarlier"
      :fill-gap="conversation.fillGap"
      @open-ticket="$emit('open-ticket', $event)"
      @open-detail="$emit('open-rail', 'detail')"
      @open-job="(jobId) => $emit('open-rail', 'jobs', jobId)"
      @open-question="openQuestion"
    />

    <div class="dock">
      <div class="dock-inner">
        <p v-if="conversation.error.value || interrupting.error.value" class="composer-error" role="alert">
          {{ conversation.error.value ?? interrupting.error.value }}
        </p>
        <template v-if="open">
          <QuestionReview
            v-if="reviewId !== undefined"
            :client="client"
            :project="project"
            :question="reviewId"
            :tickets="tickets"
            @close="reviewId = undefined"
            @open-ticket="$emit('open-ticket', $event)"
          />
          <QuestionCard
            v-else-if="ticketQuestions.length > 0 && !later"
            :questions="ticketQuestions"
            :tickets="tickets"
            :focus-id="focusId"
            :answer="answer"
            @later="later = true"
            @open-ticket="$emit('open-ticket', $event)"
          />
          <template v-else>
            <QuestionStrip
              v-if="ticketQuestions.length > 0"
              :question="ticketQuestions[0]!"
              :count="ticketQuestions.length"
              :tickets="tickets"
              :answer="answer"
              @expand="later = false"
              @open-ticket="$emit('open-ticket', $event)"
            />
            <QueuedDock
              :messages="queued"
              :busy="queuedBusy"
              can-steer
              @edit="queueEdit"
              @withdraw="queueWithdraw"
              @steer="queueSteer"
            />
            <Composer
              :draft-key="`w:${project}:${ticketId}`"
              :send="send"
              :stop="conversation.running.value ? () => interrupting.run(interrupt) : undefined"
              :tickets="tickets ?? []"
              :placeholder="t('Message {ticket}', { ticket: ticketId })"
            >
              <template v-if="conversation.running.value" #actions>
                <div
                  v-seg
                  class="seg sm"
                  role="group"
                  :aria-label="t('Delivery timing')"
                >
                  <button
                    type="button"
                    :class="{ on: mode === 'steer' }"
                    :aria-pressed="mode === 'steer'"
                    :title="t('Seen as soon as the current tool calls finish')"
                    @click="mode = 'steer'"
                  >
                    {{ t("Steer") }}
                  </button>
                  <button
                    type="button"
                    :class="{ on: mode === 'followUp' }"
                    :aria-pressed="mode === 'followUp'"
                    :title="t('Starts a new turn after this one ends')"
                    @click="mode = 'followUp'"
                  >
                    {{ t("Queue") }}
                  </button>
                </div>
              </template>
              <template v-if="conversation.running.value" #end>
                <button
                  type="button"
                  class="stop"
                  :disabled="interrupting.busy.value"
                  :title="t('Interrupt this turn (the ticket stays open)')"
                  :aria-label="t('Interrupt this turn')"
                  @click="interrupting.run(interrupt)"
                >
                  <Icon name="stop" size="sm" />
                </button>
              </template>
            </Composer>
          </template>
        </template>
        <p v-else-if="view" class="dock-note">
          {{ view.ticket.status === "done" ? t("Done") : t("Cancelled")
          }}{{ view.ticket.closeNote ? ` · ${view.ticket.closeNote}` : "" }}
        </p>
      </div>
    </div>
  </section>
</template>
