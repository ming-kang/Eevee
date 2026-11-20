<script setup lang="ts">
import type { ProjectSummary, TicketView } from "@shared/api/contract.ts";
import { effectiveStage } from "../board.ts";
import { t } from "../i18n.ts";
import type { ProjectRowState } from "../projects.ts";
import { formatRoute } from "../router.ts";
import { formatRelativeTime } from "../time.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";

defineProps<{
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
        :aria-controls="`project-tickets-${project.id}`"
        :aria-label="`${expanded ? t('Collapse tickets') : t('Expand tickets')}: ${project.title}`"
        :title="expanded ? t('Collapse tickets') : t('Expand tickets')"
        @click.stop="$emit('toggle-expand')"
      >
        <Icon name="chevR" size="xs" />
      </button>
      <a
        class="p-row"
        :href="href"
        :aria-label="project.title"
        :aria-current="active ? 'page' : undefined"
        :title="project.title"
        @click="$emit('select')"
      >
        <span class="p-title">{{ project.title }}</span>
        <span class="p-end" :class="`s-${state.kind}`">
          <span v-if="state.kind === 'user'" class="count user">{{ state.questionCount }}</span>
          <StageGlyph v-else-if="state.kind === 'bad'" stage="blocked" />
          <StageGlyph v-else-if="state.kind === 'run'" stage="working" />
          <span v-else-if="state.activeAt !== undefined" class="p-time">
            {{ formatRelativeTime(state.activeAt, nowMs, "short") }}
          </span>
        </span>
      </a>
    </div>

    <div v-if="expanded && tickets.length > 0" :id="`project-tickets-${project.id}`" class="p-tickets">
      <a
        v-for="view in tickets"
        :key="view.ticket.id"
        class="p-ticket"
        :class="{ on: activeTicketId === view.ticket.id }"
        :href="formatRoute({ name: 'worker', pid: project.id, tid: view.ticket.id })"
        :title="`${view.ticket.id} · ${view.ticket.title}`"
        :aria-current="activeTicketId === view.ticket.id ? 'page' : undefined"
        @click="$emit('select')"
      >
        <StageGlyph :stage="effectiveStage(view)" />
        <span class="pt-title">{{ view.ticket.title }}</span>
        <span class="pt-id mono">{{ view.ticket.id }}</span>
      </a>
    </div>
  </div>
</template>
