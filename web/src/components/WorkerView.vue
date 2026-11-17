<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { TicketView } from "@shared/api/contract.ts";
import type { Question, QuestionId, TicketId } from "@shared/contracts/index.ts";
import { computed, ref, type ShallowRef, watch } from "vue";
import { effectiveStage, type RailTab } from "../board.ts";
import { useConversationWatch } from "../engine-data.ts";
import { STAGE_LABEL } from "../labels.ts";
import type { StreamClient } from "../stream.ts";
import { useSubmit } from "../submit.ts";
import { mapTranscript } from "../transcript-map.ts";
import Composer from "./Composer.vue";
import Icon from "./Icon.vue";
import QuestionCard from "./QuestionCard.vue";
import QuestionStrip from "./QuestionStrip.vue";
import StageGlyph from "./StageGlyph.vue";
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
    ticketId: props.ticketId as TicketId,
    reports: props.view?.reports,
    ticketStatus: props.view?.ticket.status,
    ticketStage: props.view?.stage,
  }),
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
      <button type="button" class="btn ghost icon menu-btn" title="菜单" aria-label="菜单" @click="$emit('open-side')">
        <Icon name="menu" />
      </button>
      <button
        type="button"
        class="btn ghost sm icon"
        title="回到 Router 主对话"
        aria-label="回到 Router 主对话"
        @click="$emit('close')"
      >
        <Icon name="chevL" size="sm" />
      </button>
      <span class="t-id-h">{{ ticketId }}</span>
      <h1 class="ellipsis">
        {{ view ? view.ticket.title : boardLoaded ? `找不到工单 ${ticketId}` : ticketId }}
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
        详情
      </button>
    </header>

    <div v-if="displayItems.length === 0" class="chat">
      <div class="chat-inner" style="min-height: 100%">
        <div class="empty">
          <p class="muted">
            {{
              !view && boardLoaded
                ? `找不到工单 ${ticketId}`
                : view?.stage === "queued"
                  ? "排队中 · 等待空闲的 Worker 槽位…"
                  : "执行对话还没有开始。"
            }}
          </p>
        </div>
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

    <p
      v-if="conversation.error.value || interrupting.error.value"
      class="error"
      style="margin: 0; padding: 0 24px 6px; font-size: 12px"
    >
      {{ conversation.error.value ?? interrupting.error.value }}
    </p>

    <div class="dock">
      <div class="dock-inner">
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
            <Composer
              :draft-key="`w:${project}:${ticketId}`"
              :send="send"
              :placeholder="
                conversation.running.value
                  ? mode === 'steer'
                    ? 'Worker 正在执行，引导消息将在本批工具结束后送达…'
                    : 'Worker 正在执行，消息将排在本轮结束后送达…'
                  : `给 ${ticketId} 的 Worker 发消息…`
              "
            >
              <template v-if="conversation.running.value" #actions>
                <div
                  class="seg"
                  title="引导：本批工具调用结束后立刻看到&#10;排队：这一轮结束后再开始新的一轮"
                >
                  <button
                    type="button"
                    :class="{ on: mode === 'steer' }"
                    @click="mode = 'steer'"
                  >
                    引导
                  </button>
                  <button
                    type="button"
                    :class="{ on: mode === 'followUp' }"
                    @click="mode = 'followUp'"
                  >
                    排队
                  </button>
                </div>
                <button
                  type="button"
                  class="stop"
                  :disabled="interrupting.busy.value"
                  title="打断这一轮（工单仍为 open）"
                  aria-label="打断这一轮"
                  @click="interrupting.run(interrupt)"
                >
                  <Icon name="stop" size="xs" />
                </button>
              </template>
            </Composer>
          </template>
        </template>
        <p v-else-if="view" class="hint" style="margin: 4px 0; text-align: center">
          工单{{ view.ticket.status === "done" ? "已结单" : "已取消"
          }}{{ view.ticket.closeNote ? `：${view.ticket.closeNote}` : "" }}
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.worker {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
