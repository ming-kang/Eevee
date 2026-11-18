<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { BoardView, ProjectSummary } from "@shared/api/contract.ts";
import { computed } from "vue";
import {
  collectRunningJobs,
  countPendingQuestions,
  groupTickets,
  type RailTab,
  resolveRailTab,
} from "../board.ts";
import { onRovingKeydown } from "../focus.ts";
import { vSeg } from "../dom.ts";
import DetailTab from "./DetailTab.vue";
import Icon from "./Icon.vue";
import JobsTab from "./JobsTab.vue";
import TicketsTab from "./TicketsTab.vue";

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
  "close-drawer": [];
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
  const list: { key: RailTab; label: string; count: number; dot: boolean }[] = [
    {
      key: "tickets",
      label: "工单",
      count: groups.value.openCount,
      dot: pendingQuestions.value > 0 && effectiveTab.value !== "tickets",
    },
    {
      key: "jobs",
      label: "作业",
      count: jobs.value.length,
      dot: false,
    },
  ];
  if (props.hasDetail) {
    list.push({ key: "detail", label: "详情", count: 0, dot: false });
  }
  return list;
});
</script>

<template>
  <div class="rail-head">
    <div
      v-seg
      class="seg sm rtabs"
      role="tablist"
      aria-label="工单栏标签"
      @keydown="
        onRovingKeydown(
          $event,
          tabs.map((t) => t.key),
          effectiveTab,
          (key) => emit('update:tab', key),
        )
      "
    >
      <button
        v-for="item in tabs"
        :id="`rail-tab-${item.key}`"
        :key="item.key"
        type="button"
        role="tab"
        aria-controls="rail-panel"
        :aria-selected="effectiveTab === item.key"
        :tabindex="effectiveTab === item.key ? 0 : -1"
        :class="{ on: effectiveTab === item.key }"
        @click="emit('update:tab', item.key)"
      >
        <span>{{ item.label }}</span>
        <span v-if="item.count > 0" class="n">{{ item.count }}</span>
        <span v-if="item.dot" class="dot user" aria-hidden="true" />
        <span v-if="item.dot" class="sr">（有待回答问题）</span>
      </button>
    </div>
    <button
      type="button"
      class="btn ghost sm icon rail-close"
      aria-label="关闭工单栏"
      @click="emit('close-drawer')"
    >
      <Icon name="x" size="sm" />
    </button>
  </div>
  <div
    id="rail-panel"
    class="rail-scroll"
    role="tabpanel"
    :aria-labelledby="`rail-tab-${effectiveTab}`"
  >
    <p v-if="error" class="error hint rail-note">{{ error }}</p>
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
