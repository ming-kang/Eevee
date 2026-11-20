<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { QuestionId } from "@shared/domain/index.ts";
import type { BoardView, ProjectSummary } from "@shared/protocol/contract.ts";
import { computed, nextTick, ref, type ShallowRef, watch } from "vue";
import type { StreamClient } from "../../lib/stream.ts";
import { displayId } from "../../lib/ids.ts";
import {
  collectRunningJobs,
  countPendingQuestions,
  effectiveStage,
  groupTickets,
  type RailTab,
  resolveRailView,
} from "../../lib/board.ts";
import { t } from "../../lib/i18n.ts";
import { STAGE_LABEL } from "../../lib/labels.ts";
import { ID_TEXT } from "./stage.ts";
import StageGlyph from "./StageGlyph.vue";
import DetailTab from "./DetailTab.vue";
import JobsTab from "./JobsTab.vue";
import TicketsTab from "./TicketsTab.vue";
import Segmented from "../../ui/Segmented.vue";
import Button from "../../ui/Button.vue";
import Icon from "../../ui/Icon.vue";
import WorkerView from "./WorkerView.vue";

const props = defineProps<{
  client: Client;
  stream: ShallowRef<StreamClient | undefined>;
  board: BoardView | undefined;
  project: ProjectSummary | undefined;
  error: string | undefined;
  tab: RailTab;
  maximized: boolean;
  activeTicketId?: string;
  questionId?: QuestionId;
  openJobId?: string;
}>();

const emit = defineEmits<{
  "update:tab": [tab: RailTab];
  "update:openJobId": [jobId: string | undefined];
  "open-ticket": [ticketId: string];
  "close-ticket": [];
  "question-route": [questionId: QuestionId | undefined];
  "toggle-maximize": [];
  "open-rail": [tab?: RailTab, jobId?: string];
}>();

const railView = computed(() => resolveRailView(props.tab, props.activeTicketId));
const workerPanel = ref<"conversation" | "details">("conversation");
const backButton = ref<{ focus(): void }>();
watch(() => props.activeTicketId, (id, previous) => {
  workerPanel.value = "conversation";
  if (id) void nextTick(() => backButton.value?.focus());
  if (previous && !id) void nextTick(() => document.getElementById(`rail-tab-${props.tab}`)?.focus());
}, { immediate: true });
watch(() => props.questionId, (id) => { if (id !== undefined) workerPanel.value = "conversation"; });
const groups = computed(() => groupTickets(props.board?.tickets ?? []));
const jobs = computed(() => collectRunningJobs(props.board?.tickets ?? []));
const pendingQuestions = computed(() => countPendingQuestions(props.board));
const activeTicket = computed(() =>
  props.activeTicketId
    ? props.board?.tickets.find((t) => t.ticket.id === props.activeTicketId)
    : undefined,
);
const stage = computed(() => activeTicket.value ? effectiveStage(activeTicket.value) : undefined);

function onEscape(event: KeyboardEvent): void {
  if (event.defaultPrevented || !props.activeTicketId) return;
  event.preventDefault();
  event.stopPropagation();
  emit("close-ticket");
}

const tabs = computed(() => {
  const list: { key: RailTab; label: string; dot: boolean }[] = [
    {
      key: "tickets",
      label: t("Tickets"),
      dot: pendingQuestions.value > 0 && props.tab !== "tickets",
    },
    {
      key: "jobs",
      label: t("Jobs"),
      dot: false,
    },
  ];
  return list;
});
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col" @keydown.esc="onEscape">
  <div class="rail-head">
    <template v-if="activeTicketId">
      <Button ref="backButton" variant="ghost" size="sm" icon :aria-label="t('Back to tickets')" :title="t('Back to tickets')" @click="emit('close-ticket')"><Icon name="arrowL" size="sm" /></Button>
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <span :class="ID_TEXT" class="shrink-0">{{ displayId(activeTicketId) }}</span>
        <h2 class="ellipsis min-w-0 text-sm font-medium" :title="activeTicket?.ticket.title">{{ activeTicket ? activeTicket.ticket.title : board ? t('Ticket {id} not found', { id: activeTicketId }) : '' }}</h2>
        <StageGlyph v-if="stage" :stage="stage" :title="STAGE_LABEL[stage]" />
      </div>
      <Segmented v-model="workerPanel" :options="[{ value: 'conversation', label: t('Conversation') }, { value: 'details', label: t('Details') }]" :label="t('Worker view')" />
      <Button variant="ghost" size="sm" icon :aria-label="maximized ? t('Restore Worker panel') : t('Maximize Worker panel')" :title="maximized ? t('Restore Worker panel') : t('Maximize Worker panel')" @click="emit('toggle-maximize')"><Icon :name="maximized ? 'minimize' : 'maximize'" size="sm" /></Button>
    </template>
    <Segmented v-else :model-value="tab" mode="tabs" class="min-w-0" id-prefix="rail-tab" controls="rail-panel" :options="tabs.map((item) => ({ value: item.key, label: item.label }))" :label="t('Ticket rail tabs')" @update:model-value="emit('update:tab', $event)">
      <template #default="{ option, index }">
        <span>{{ option.label }}</span>
        <span v-if="tabs[index]?.dot" class="size-1.5 flex-none rounded-full bg-(--ev-user)" aria-hidden="true" />
        <span v-if="tabs[index]?.dot" class="sr">{{ t("(questions waiting)") }}</span>
      </template>
    </Segmented>
  </div>
  <div
    id="rail-panel"
    class="flex min-h-0 flex-1 flex-col"
    :role="activeTicketId ? 'region' : 'tabpanel'"
    :aria-label="activeTicketId ? t('Worker view') : undefined"
    :aria-labelledby="activeTicketId ? undefined : `rail-tab-${tab}`"
  >
    <p v-if="error" class="error hint px-2.5 py-1.5">{{ error }}</p>
    <div v-show="railView !== 'detail'" class="rail-scroll">
    <TicketsTab
      v-if="tab === 'tickets'"
      :board="board"
      :groups="groups"
      :active-ticket-id="activeTicketId"
      @open-ticket="emit('open-ticket', $event)"
    />
    <JobsTab
      v-else-if="tab === 'jobs'"
      :client="client"
      :project-id="project?.id"
      :jobs="jobs"
      :open-job-id="openJobId"
      @update:open-job-id="emit('update:openJobId', $event)"
      @open-ticket="emit('open-ticket', $event)"
    />
    </div>
    <div v-if="activeTicketId && project" class="@container/vp flex min-h-0 flex-1 flex-col">
      <WorkerView
        v-show="workerPanel === 'conversation'"
        :key="`${project.id}:${activeTicketId}`"
        :client="client"
        :stream="stream"
        :project="project.id"
        :ticket-id="activeTicketId"
        :question-id="questionId"
        :view="activeTicket"
        :tickets="board?.tickets"
        :open-questions="board?.openQuestions"
        :board-loaded="board !== undefined"
        @open-details="workerPanel = 'details'"
        @question-route="emit('question-route', $event)"
        @open-rail="(tab, jobId) => emit('open-rail', tab, jobId)"
        @open-ticket="emit('open-ticket', $event)"
      />
      <div v-if="workerPanel === 'details'" class="rail-scroll">
      <DetailTab
      :ticket-id="activeTicketId"
      :view="activeTicket"
      :tickets="board?.tickets"
      :project-models="project?.models"
      :loaded="board !== undefined"
      @open-ticket="emit('open-ticket', $event)"
    />
      </div>
    </div>
  </div>
  </section>
</template>
