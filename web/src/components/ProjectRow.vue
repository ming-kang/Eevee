<script setup lang="ts">
import type { ProjectSummary, TicketView } from "@shared/api/contract.ts";
import { computed } from "vue";
import { effectiveStage, ticketActivityAt } from "../board.ts";
import { t } from "../i18n.ts";
import { ROLE_LABEL, STAGE_LABEL } from "../labels.ts";
import type { ProjectRowState } from "../projects.ts";
import { formatRoute } from "../router.ts";
import { formatRelativeTime } from "../time.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";

const props = defineProps<{
  project: ProjectSummary;
  state: ProjectRowState;
  tickets: readonly TicketView[];
  expanded: boolean;
  active: boolean;
  current: boolean;
  activeTicketId?: string;
  href: string;
  nowMs?: number;
}>();

const projectAt = computed(() => props.state.activeAt ?? props.project.createdAt);
const statusLabel = computed(() => {
  if (props.state.kind === "user") {
    return t("{n} question needs an answer|{n} questions need an answer", { n: props.state.questionCount });
  }
  if (props.state.kind === "bad") return props.state.routerFailed ?? t("Blocked");
  return props.state.kind === "run" ? t("Working") : t("Idle");
});
const sidebarTickets = computed(() => props.tickets.map((view) => ({
  ...view,
  activeAt: ticketActivityAt(view),
})));

function ticketLabel(view: TicketView): string {
  return `${view.ticket.id} · ${ROLE_LABEL[view.ticket.role]} · ${STAGE_LABEL[effectiveStage(view)]} · ${view.ticket.title}`;
}

defineEmits<{
  select: [];
  "toggle-expand": [];
  "hover-enter": [el: HTMLElement];
  "hover-leave": [event: MouseEvent];
}>();
</script>

<template>
  <div class="p-group" :class="{ expanded: expanded && tickets.length > 0 }">
    <div
      class="p-item"
      :class="{ on: active, cur: current && !activeTicketId }"
      @mouseenter="$emit('hover-enter', $event.currentTarget as HTMLElement)"
      @mouseleave="$emit('hover-leave', $event)"
    >
      <button
        v-if="tickets.length > 0"
        type="button"
        class="p-exp"
        :aria-expanded="expanded"
        :aria-controls="expanded ? `project-tickets-${project.id}` : undefined"
        :aria-label="`${expanded ? t('Collapse tickets') : t('Expand tickets')}: ${project.title}`"
        :title="expanded ? t('Collapse tickets') : t('Expand tickets')"
        @click.stop="$emit('toggle-expand')"
      >
        <Icon name="chevR" size="xs" />
      </button>
      <a
        class="p-row"
        :href="href"
        :aria-label="`${project.title} · ${statusLabel}`"
        :aria-current="active ? 'page' : undefined"
        :title="project.title"
        @click="$emit('select')"
      >
        <span class="p-status" :title="statusLabel" aria-hidden="true">
          <span v-if="state.kind === 'user'" class="count user">{{ state.questionCount > 99 ? "99+" : state.questionCount }}</span>
          <StageGlyph v-else-if="state.kind === 'bad'" stage="blocked" />
          <StageGlyph v-else-if="state.kind === 'run'" stage="working" />
          <StageGlyph v-else stage="idle" />
        </span>
        <span class="p-title">{{ project.title }}</span>
        <time
          class="p-time"
          :datetime="new Date(projectAt).toISOString()"
          :title="state.activeAt === undefined
            ? t('Created {time}', { time: formatRelativeTime(projectAt, nowMs) })
            : t('Last active {time}', { time: formatRelativeTime(projectAt, nowMs) })"
        >{{ formatRelativeTime(projectAt, nowMs, "short") }}</time>
      </a>
    </div>

    <div v-if="expanded && tickets.length > 0" :id="`project-tickets-${project.id}`" class="p-tickets">
      <a
        v-for="view in sidebarTickets"
        :key="view.ticket.id"
        class="p-ticket"
        :class="{ on: activeTicketId === view.ticket.id }"
        :href="formatRoute({ name: 'worker', pid: project.id, tid: view.ticket.id })"
        :title="ticketLabel(view)"
        :aria-label="ticketLabel(view)"
        :aria-current="activeTicketId === view.ticket.id ? 'page' : undefined"
        @click="$emit('select')"
      >
        <StageGlyph :stage="effectiveStage(view)" />
        <span class="pt-title">{{ view.ticket.title }}</span>
        <time
          class="p-time"
          :datetime="new Date(view.activeAt).toISOString()"
          :title="`${ROLE_LABEL[view.ticket.role]} · ${t('Last active {time}', { time: formatRelativeTime(view.activeAt, nowMs) })} · ${view.ticket.id}`"
        >{{ formatRelativeTime(view.activeAt, nowMs, "short") }}</time>
      </a>
    </div>
  </div>
</template>
