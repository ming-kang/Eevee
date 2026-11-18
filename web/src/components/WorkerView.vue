<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { TicketView } from "@shared/api/contract.ts";
import type { Question, QuestionId, TicketId } from "@shared/contracts/index.ts";
import { computed, ref, type ShallowRef, watch } from "vue";
import { effectiveStage, type RailTab } from "../board.ts";
import { useConversationWatch } from "../engine-data.ts";
import { t } from "../i18n.ts";
import { STAGE_LABEL } from "../labels.ts";
import { vSeg } from "../dom.ts";
import type { StreamClient } from "../stream.ts";
import { useSubmit } from "../submit.ts";
import { mapTranscript } from "../transcript-map.ts";
import Composer from "./Composer.vue";
import Icon from "./Icon.vue";
import QuestionCard from "./QuestionCard.vue";
import QuestionStrip from "./QuestionStrip.vue";
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
}>();

defineEmits<{
  close: [];
  "open-side": [];
  "open-rail": [tab?: RailTab, jobId?: string];
  "open-ticket": [ticketId: string];
}>();

const params = computed(() => ({ project: props.project, ticket: props.ticketId }));
const conversation = useConversationWatch(props.stream, () => ({
  kind: "conversation",
  project: props.project,
  ticket: props.ticketId as TicketId,
}));

const displayItems = computed(() =>
  mapTranscript(conversation.view.value?.items ?? [], {
    mode: "worker",
    live: conversation.live.value,
    inbox: conversation.inbox.value,
    ticketId: props.ticketId as TicketId,
    reports: props.view?.reports,
    ticketStatus: props.view?.ticket.status,
    ticketStage: props.view?.stage,
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

async function interrupt(): Promise<void> {
  await props.client.call("POST /api/projects/:project/tickets/:ticket/interrupt", params.value);
}

async function retry(): Promise<void> {
  await props.client.call("POST /api/projects/:project/tickets/:ticket/retry", params.value);
}

async function answer(id: QuestionId, text: string): Promise<void> {
  await props.client.call(
    "POST /api/projects/:project/questions/:question/answer",
    { project: props.project, question: id },
    { answer: text },
  );
}
</script>

<template>
  <section class="worker">
    <header class="header">
      <button type="button" class="btn ghost sm icon menu-btn" :aria-label="t('菜单')" @click="$emit('open-side')">
        <Icon name="menu" size="sm" />
      </button>
      <button
        type="button"
        class="btn ghost sm icon back-btn"
        :title="t('回到 Router')"
        :aria-label="t('回到 Router 主对话')"
        @click="$emit('close')"
      >
        <Icon name="chevL" size="sm" />
      </button>
      <span class="t-id-h">{{ ticketId }}</span>
      <h1 class="ellipsis">
        {{ view ? view.ticket.title : boardLoaded ? t("找不到工单 {id}", { id: ticketId }) : "" }}
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
      <button type="button" class="btn ghost sm rail-btn" @click="$emit('open-rail', 'detail')">
        {{ t("详情") }}
      </button>
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
              ? t("找不到工单 {id}", { id: ticketId })
              : view?.stage === "queued"
                ? t("排队中")
                : conversation.view.value
                  ? t("尚未开始")
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
      :loading-earlier="conversation.loadingEarlier.value"
      :filling-gaps="conversation.fillingGaps.value"
      :retry="open ? retry : undefined"
      :load-earlier="conversation.loadEarlier"
      :fill-gap="conversation.fillGap"
      @open-ticket="$emit('open-ticket', $event)"
      @open-detail="$emit('open-rail', 'detail')"
      @open-job="(jobId) => $emit('open-rail', 'jobs', jobId)"
    />

    <div class="dock">
      <div class="dock-inner">
        <p v-if="conversation.error.value || interrupting.error.value" class="composer-error" role="alert">
          {{ conversation.error.value ?? interrupting.error.value }}
        </p>
        <template v-if="open">
          <QuestionCard
            v-if="ticketQuestions.length > 0 && !later"
            :questions="ticketQuestions"
            :tickets="tickets"
            :answer="answer"
            @later="later = true"
            @open-ticket="$emit('open-ticket', $event)"
          />
          <template v-else>
            <QuestionStrip
              v-if="ticketQuestions.length > 0"
              :count="ticketQuestions.length"
              @expand="later = false"
            />
            <Composer :draft-key="`w:${project}:${ticketId}`" :send="send" :placeholder="t('发消息给 {ticket}', { ticket: ticketId })">
              <template v-if="conversation.running.value" #actions>
                <div
                  v-seg
                  class="seg sm"
                  role="group"
                  :aria-label="t('送达时机')"
                >
                  <button
                    type="button"
                    :class="{ on: mode === 'steer' }"
                    :aria-pressed="mode === 'steer'"
                    :title="t('本批工具调用结束后立刻看到')"
                    @click="mode = 'steer'"
                  >
                    {{ t("引导") }}
                  </button>
                  <button
                    type="button"
                    :class="{ on: mode === 'followUp' }"
                    :aria-pressed="mode === 'followUp'"
                    :title="t('这一轮结束后再开始新的一轮')"
                    @click="mode = 'followUp'"
                  >
                    {{ t("排队") }}
                  </button>
                </div>
              </template>
              <template v-if="conversation.running.value" #end>
                <button
                  type="button"
                  class="stop"
                  :disabled="interrupting.busy.value"
                  :title="t('打断这一轮（工单仍为 open）')"
                  :aria-label="t('打断这一轮')"
                  @click="interrupting.run(interrupt)"
                >
                  <Icon name="stop" size="sm" />
                </button>
              </template>
            </Composer>
          </template>
        </template>
        <p v-else-if="view" class="dock-note">
          {{ view.ticket.status === "done" ? t("已结单") : t("已取消")
          }}{{ view.ticket.closeNote ? ` · ${view.ticket.closeNote}` : "" }}
        </p>
      </div>
    </div>
  </section>
</template>
