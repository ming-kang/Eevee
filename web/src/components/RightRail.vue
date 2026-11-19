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
import { t } from "../i18n.ts";
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
  railShortcut: string;
}>();

const emit = defineEmits<{
  "update:tab": [tab: RailTab];
  "update:openJobId": [jobId: string | undefined];
  "open-ticket": [ticketId: string];
  "close-drawer": [];
  /** Fold the rail column away on wide screens (drawer mode closes through "close-drawer"). */
  "collapse-rail": [];
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
      label: t("Tickets"),
      count: groups.value.openCount,
      dot: pendingQuestions.value > 0 && effectiveTab.value !== "tickets",
    },
    {
      key: "jobs",
      label: t("Jobs"),
      count: jobs.value.length,
      dot: false,
    },
  ];
  if (props.hasDetail) {
    list.push({ key: "detail", label: t("Details"), count: 0, dot: false });
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
      :aria-label="t('Ticket rail tabs')"
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
        <span v-if="item.dot" class="sr">{{ t("(questions waiting)") }}</span>
      </button>
    </div>
    <button
      type="button"
      class="btn ghost sm icon rail-fold"
      :title="t('Collapse the tickets panel ({key})', { key: railShortcut })"
      :aria-label="t('Collapse the tickets panel')"
      @click="emit('collapse-rail')"
    >
      <Icon name="panel" size="sm" />
    </button>
    <button
      type="button"
      class="btn ghost sm icon rail-close"
      :aria-label="t('Close the ticket rail')"
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
