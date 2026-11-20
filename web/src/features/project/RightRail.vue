<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { QuestionId } from "@shared/domain/index.ts";
import type { BoardView, ProjectSummary } from "@shared/protocol/contract.ts";
import { computed, ref, type ShallowRef, watch } from "vue";
import type { StreamClient } from "../../lib/stream.ts";
import { displayId } from "../../lib/ids.ts";
import {
  collectRunningJobs,
  countPendingQuestions,
  groupTickets,
  type RailTab,
  resolveRailTab,
} from "../../lib/board.ts";
import { t } from "../../lib/i18n.ts";
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

const effectiveTab = computed(() => resolveRailTab(props.tab, !!props.activeTicketId));
const workerPanel = ref<"conversation" | "details">("conversation");
watch(() => props.activeTicketId, () => { workerPanel.value = "conversation"; });
watch(() => props.questionId, (id) => { if (id !== undefined) workerPanel.value = "conversation"; });
const groups = computed(() => groupTickets(props.board?.tickets ?? []));
const jobs = computed(() => collectRunningJobs(props.board?.tickets ?? []));
const pendingQuestions = computed(() => countPendingQuestions(props.board));
const activeTicket = computed(() =>
  props.activeTicketId
    ? props.board?.tickets.find((t) => t.ticket.id === props.activeTicketId)
    : undefined,
);

const tabs = computed(() => {
  const list: { key: RailTab; label: string; dot: boolean }[] = [
    {
      key: "tickets",
      label: t("Tickets"),
      dot: pendingQuestions.value > 0 && effectiveTab.value !== "tickets",
    },
    {
      key: "jobs",
      label: t("Jobs"),
      dot: false,
    },
  ];
  if (props.activeTicketId) {
    list.push({ key: "worker", label: displayId(props.activeTicketId), dot: false });
  }
  return list;
});
</script>

<template>
  <div class="rail-head">
    <Segmented :model-value="effectiveTab" mode="tabs" class="min-w-0" id-prefix="rail-tab" controls="rail-panel" :options="tabs.map((item) => ({ value: item.key, label: item.label }))" :label="t('Ticket rail tabs')" @update:model-value="emit('update:tab', $event)">
      <template #default="{ option, index }">
        <span>{{ option.label }}</span>
        <span v-if="tabs[index]?.dot" class="size-1.5 flex-none rounded-full bg-(--ev-user)" aria-hidden="true" />
        <span v-if="tabs[index]?.dot" class="sr">{{ t("(questions waiting)") }}</span>
      </template>
    </Segmented>
    <Button v-if="activeTicketId" variant="ghost" size="sm" icon :aria-label="t('Close {ticket}', { ticket: displayId(activeTicketId) })" @click="emit('close-ticket')"><Icon name="x" size="xs" /></Button>
    <span class="spacer" />
    <Button v-if="effectiveTab === 'worker'" variant="ghost" size="sm" icon :aria-label="maximized ? t('Restore Worker panel') : t('Maximize Worker panel')" :title="maximized ? t('Restore Worker panel') : t('Maximize Worker panel')" @click="emit('toggle-maximize')"><Icon :name="maximized ? 'panelClose' : 'panel'" size="sm" /></Button>
  </div>
  <div
    id="rail-panel"
    class="flex min-h-0 flex-1 flex-col"
    role="tabpanel"
    :aria-labelledby="`rail-tab-${effectiveTab}`"
  >
    <p v-if="error" class="error hint px-2.5 py-1.5">{{ error }}</p>
    <div v-show="effectiveTab !== 'worker'" class="rail-scroll">
    <TicketsTab
      v-if="effectiveTab === 'tickets'"
      :board="board"
      :groups="groups"
      :active-ticket-id="activeTicketId"
      @open-ticket="emit('open-ticket', $event)"
    />
    <JobsTab
      v-else-if="effectiveTab === 'jobs'"
      :client="client"
      :project-id="project?.id"
      :jobs="jobs"
      :open-job-id="openJobId"
      @update:open-job-id="emit('update:openJobId', $event)"
      @open-ticket="emit('open-ticket', $event)"
    />
    </div>
    <div v-if="activeTicketId && project" v-show="effectiveTab === 'worker'" class="@container/vp flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 justify-end border-b border-separator px-3 py-2">
        <Segmented v-model="workerPanel" :options="[{ value: 'conversation', label: t('Conversation') }, { value: 'details', label: t('Details') }]" :label="t('Worker view')" />
      </div>
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
</template>
