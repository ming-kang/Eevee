<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { TicketView } from "@shared/protocol/contract.ts";
import type { Question, QuestionId, TicketId } from "@shared/domain/index.ts";
import { computed, ref, type ShallowRef, watch } from "vue";
import { effectiveStage, type RailTab } from "../../lib/board.ts";
import { provideComposerInsert } from "../../composables/composer-bridge.ts";
import { useConversationWatch } from "../../composables/engine-data.ts";
import { errorText } from "../../lib/errors.ts";
import { t } from "../../lib/i18n.ts";
import { STAGE_LABEL } from "../../lib/labels.ts";
import type { StreamClient } from "../../lib/stream.ts";
import { useSubmit } from "../../composables/submit.ts";
import { showToast } from "../../composables/toasts.ts";
import { mapTranscript, type QueuedMessage, queuedMessages } from "../../lib/transcript-map.ts";
import Composer from "../conversation/Composer.vue";
import Icon from "../../ui/Icon.vue";
import QuestionCard from "../conversation/QuestionCard.vue";
import QuestionReview from "../conversation/QuestionReview.vue";
import QuestionStrip from "../conversation/QuestionStrip.vue";
import QueuedDock from "../conversation/QueuedDock.vue";
import Skeleton from "../../ui/Skeleton.vue";
import StageGlyph from "./StageGlyph.vue";
import Transcript from "../conversation/Transcript.vue";
import Segmented from "../../ui/Segmented.vue";
import { STOP } from "../conversation/composer.ts";
import { displayId } from "../../lib/ids.ts";
import { COMPOSER_STACK, DOCK, DOCK_INNER, DOCK_NOTE } from "../conversation/dock.ts";
import { EMPTY, ERROR_TEXT } from "../../ui/surface.ts";
import { ID_TEXT, stagePill } from "./stage.ts";

const props = defineProps<{
  client: Client;
  stream: ShallowRef<StreamClient | undefined>;
  project: string;
  projectTitle?: string;
  view: TicketView | undefined;
  tickets?: readonly TicketView[];
  openQuestions?: readonly Question[];
  boardLoaded?: boolean;
  ticketId: string;
}>();

defineEmits<{
  close: [];
  "open-rail": [tab?: RailTab, jobId?: string];
  "open-ticket": [ticketId: string];
}>();

const params = computed(() => ({ project: props.project, conversation: props.ticketId }));
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
  await props.client.call("POST /api/projects/:project/conversations/:conversation/messages", params.value, {
    text,
    mode: mode.value,
  });
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

async function retry(): Promise<void> {
  await props.client.call("POST /api/projects/:project/conversations/:conversation/retry", params.value);
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
        "DELETE /api/projects/:project/conversations/:conversation/queue/:submission",
        { ...params.value, submission: message.id },
      );
    },
    () => bridge.insert(message.text, "start"),
  );
}

function queueWithdraw(message: QueuedMessage): Promise<void> {
  return queueAction(message, async () => {
    await props.client.call(
      "DELETE /api/projects/:project/conversations/:conversation/queue/:submission",
      { ...params.value, submission: message.id },
    );
  });
}

function queueSteer(message: QueuedMessage): Promise<void> {
  return queueAction(message, async () => {
    await props.client.call(
      "POST /api/projects/:project/conversations/:conversation/queue/:submission/steer",
      { ...params.value, submission: message.id },
    );
  });
}
</script>

<template>
  <section class="worker">
    <header class="header">
      <nav class="crumb" :aria-label="t('Breadcrumb')">
        <button
          type="button"
          class="crumb-parent"
          :title="t('Back to the Router')"
          :aria-label="t('Back to the Router conversation')"
          @click="$emit('close')"
        >
          <Icon name="folder" size="xs" class="crumb-ico hide-sm" />
          <span class="ellipsis hide-sm">{{ projectTitle ?? t("Router") }}</span>
          <Icon name="chevL" size="xs" class="show-sm" />
        </button>
        <span class="crumb-sep hide-sm" aria-hidden="true">/</span>
        <span :class="ID_TEXT">{{ displayId(ticketId) }}</span>
        <h1 class="ellipsis">
          {{ view ? view.ticket.title : boardLoaded ? t("Ticket {id} not found", { id: ticketId }) : "" }}
        </h1>
      </nav>
      <span
        v-if="view && stage"
        :class="stagePill(stage)"
        :title="STAGE_LABEL[stage]"
      >
        <StageGlyph :stage="stage" />
        <span class="hide-sm">{{ STAGE_LABEL[stage] }}</span>
      </span>
      <span class="spacer" />
    </header>

    <div v-if="displayItems.length === 0 && loading" class="chat">
      <div class="chat-inner">
        <Skeleton :lines="5" />
      </div>
    </div>
    <div v-else-if="displayItems.length === 0" class="chat">
      <div :class="EMPTY">
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

    <div class="dock" :class="DOCK">
      <div :class="DOCK_INNER">
        <p v-if="conversation.error.value || interrupting.error.value" :class="ERROR_TEXT" role="alert">
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
          <div
            v-else
            :class="[COMPOSER_STACK, { 'has-seam': ticketQuestions.length > 0 || queued.length > 0 }]"
          >
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
                <Segmented v-model="mode" :options="[{ value: 'steer', label: t('Steer'), title: t('Seen as soon as the current tool calls finish') }, { value: 'followUp', label: t('Queue'), title: t('Starts a new turn after this one ends') }]" :label="t('Delivery timing')" />
              </template>
              <template v-if="conversation.running.value" #end>
                <button
                  type="button"
                  :class="STOP"
                  :disabled="interrupting.busy.value"
                  :title="t('Interrupt this turn (the ticket stays open)')"
                  :aria-label="t('Interrupt this turn')"
                  @click="interrupting.run(interrupt)"
                >
                  <Icon name="stop" size="sm" />
                </button>
              </template>
            </Composer>
          </div>
        </template>
        <p v-else-if="view" :class="DOCK_NOTE">
          {{ view.ticket.status === "done" ? t("Done") : t("Cancelled")
          }}{{ view.ticket.closeNote ? ` · ${view.ticket.closeNote}` : "" }}
        </p>
      </div>
    </div>
  </section>
</template>
