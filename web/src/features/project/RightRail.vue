<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { BoardView, ProjectSummary } from "@shared/protocol/contract.ts";
import { computed } from "vue";
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

const props = defineProps<{
  client: Client;
  board: BoardView | undefined;
  project: ProjectSummary | undefined;
  error: string | undefined;
  tab: RailTab;
  hasDetail: boolean;
  activeTicketId?: string;
  openJobId?: string;
}>();

const emit = defineEmits<{
  "update:tab": [tab: RailTab];
  "update:openJobId": [jobId: string | undefined];
  "open-ticket": [ticketId: string];
}>();

const effectiveTab = computed(() => resolveRailTab(props.tab, props.hasDetail));
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
  if (props.hasDetail) {
    list.push({ key: "detail", label: t("Details"), dot: false });
  }
  return list;
});
</script>

<template>
  <div class="rail-head">
    <Segmented :model-value="effectiveTab" mode="tabs" class="mr-auto min-w-0" id-prefix="rail-tab" controls="rail-panel" :options="tabs.map((item) => ({ value: item.key, label: item.label }))" :label="t('Ticket rail tabs')" @update:model-value="emit('update:tab', $event)">
      <template #default="{ option, index }">
        <span>{{ option.label }}</span>
        <span v-if="tabs[index]?.dot" class="size-1.5 flex-none rounded-full bg-(--ev-user)" aria-hidden="true" />
        <span v-if="tabs[index]?.dot" class="sr">{{ t("(questions waiting)") }}</span>
      </template>
    </Segmented>
  </div>
  <div
    id="rail-panel"
    class="rail-scroll"
    role="tabpanel"
    :aria-labelledby="`rail-tab-${effectiveTab}`"
  >
    <p v-if="error" class="error hint px-2.5 py-1.5">{{ error }}</p>
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
    <DetailTab
      v-else-if="effectiveTab === 'detail'"
      :ticket-id="activeTicketId"
      :view="activeTicket"
      :tickets="board?.tickets"
      :project-models="project?.models"
      :loaded="board !== undefined"
      @open-ticket="emit('open-ticket', $event)"
    />
  </div>
</template>
