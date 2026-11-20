<script setup lang="ts">
import type { ProjectSummary, TicketView } from "@shared/api/contract.ts";
import { computed, ref } from "vue";
import { effectiveStage, ticketActivityAt } from "../../lib/board.ts";
import { t } from "../../lib/i18n.ts";
import { ROLE_LABEL, STAGE_LABEL } from "../../lib/labels.ts";
import type { ProjectRowState } from "../../lib/projects.ts";
import { formatRoute } from "../../lib/router.ts";
import { formatRelativeTime } from "../../lib/time.ts";
import { displayId } from "../../lib/ids.ts";
import Icon from "../../ui/Icon.vue";
import StageGlyph from "../project/StageGlyph.vue";

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
const ATTENTION = new Set(["answer", "blocked"]);
const showDone = ref(false);
const sidebarTickets = computed(() =>
  props.tickets.map((view) => {
    const stage = effectiveStage(view);
    return { ...view, glyph: stage, attention: ATTENTION.has(stage), activeAt: ticketActivityAt(view) };
  }),
);
const doneTickets = computed(() => sidebarTickets.value.filter((view) => view.ticket.closedAt !== undefined));
/** Closed tickets fold into one "Done" line unless opened, or one of them is the ticket on screen. */
const openTickets = computed(() =>
  sidebarTickets.value.filter(
    (view) => view.ticket.closedAt === undefined || showDone.value || view.ticket.id === props.activeTicketId,
  ),
);

function ticketLabel(view: TicketView): string {
  return `${displayId(view.ticket.id)} · ${ROLE_LABEL[view.ticket.role]} · ${STAGE_LABEL[effectiveStage(view)]} · ${view.ticket.title}`;
}

defineEmits<{
  select: [];
  "toggle-expand": [];
  "hover-enter": [el: HTMLElement];
  "hover-leave": [event: MouseEvent];
}>();
</script>

<template>
  <div class="flex flex-col">
    <div
      class="group/prow relative grid grid-cols-[calc(28px*var(--ev-scale))_calc(24px*var(--ev-scale))_minmax(0,1fr)] items-center rounded-sm transition-[background-color,box-shadow]"
      :class="active ? 'bg-selected [--ev-glyph-cut:var(--selected)]' : 'hover:bg-hover'"
      @mouseenter="$emit('hover-enter', $event.currentTarget as HTMLElement)"
      @mouseleave="$emit('hover-leave', $event)"
    >
      <button
        v-if="tickets.length > 0"
        type="button"
        class="z-1 col-start-2 row-start-1 inline-grid h-7 w-6 place-items-center rounded-xs text-fg-subtle opacity-0 transition-[color,opacity] group-hover/prow:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 hover:text-fg focus-visible:shadow-(--ring-inset) [&_.ico]:size-3 [&_.ico]:transition-transform aria-expanded:[&_.ico]:rotate-90"
        :aria-expanded="expanded"
        :aria-controls="expanded ? `project-tickets-${project.id}` : undefined"
        :aria-label="`${expanded ? t('Collapse tickets') : t('Expand tickets')}: ${project.title}`"
        :title="expanded ? t('Collapse tickets') : t('Expand tickets')"
        @click.stop="$emit('toggle-expand')"
      >
        <Icon name="chevR" size="xs" />
      </button>
      <a
        class="col-span-full pointer-coarse:h-9.5 row-start-1 grid min-h-8 min-w-0 grid-cols-[calc(20px*var(--ev-scale))_calc(24px*var(--ev-scale))_minmax(0,1fr)_auto] items-center rounded-sm px-2 text-sm tracking-(--ev-tracking) text-fg focus-visible:shadow-(--ring-inset)"
        :class="{ 'font-medium': active }"
        :href="href"
        :aria-label="`${project.title} · ${statusLabel}`"
        :aria-current="active ? 'page' : undefined"
        :title="project.title"
        @click="$emit('select')"
      >
        <span class="grid place-items-center [&_.count]:min-w-4.5 [&_.count]:px-0.75 [&_.count]:text-2xs [&_.glyph]:size-3.5" :title="statusLabel" aria-hidden="true">
          <StageGlyph v-if="state.kind === 'bad'" stage="blocked" />
          <StageGlyph v-else-if="state.kind === 'run'" stage="working" />
          <StageGlyph v-else stage="idle" />
        </span>
        <span class="col-start-3 min-w-0 truncate leading-5" :class="{ 'font-medium': current && !activeTicketId }">{{ project.title }}</span>
        <span v-if="state.kind === 'user'" class="ml-2 size-1.5 flex-none rounded-full bg-(--ev-user)" aria-hidden="true" />
        <time
          v-else
          class="ml-2 flex-none text-2xs text-fg-subtle tabular-nums opacity-0 transition-opacity group-hover/prow:opacity-100 [@media(hover:none)]:opacity-100"
          :datetime="new Date(projectAt).toISOString()"
          :title="state.activeAt === undefined
            ? t('Created {time}', { time: formatRelativeTime(projectAt, nowMs) })
            : t('Last active {time}', { time: formatRelativeTime(projectAt, nowMs) })"
        >{{ formatRelativeTime(projectAt, nowMs, "short") }}</time>
      </a>
    </div>

    <div v-if="expanded && tickets.length > 0" :id="`project-tickets-${project.id}`" class="mt-0.5 mb-1.5 ml-4.5 flex flex-col gap-px border-l border-separator pl-1.5">
      <a
        v-for="view in openTickets"
        :key="view.ticket.id"
        class="grid h-7.5 min-w-0 grid-cols-[calc(20px*var(--ev-scale))_minmax(0,1fr)] items-center gap-2 rounded-xs px-2 text-sm transition-[background-color,color,box-shadow] pointer-coarse:h-8.5 focus-visible:shadow-(--ring-inset) [&_.glyph]:size-3.5 [&_.glyph]:justify-self-center"
        :class="activeTicketId === view.ticket.id ? 'bg-selected font-medium text-fg [--ev-glyph-cut:var(--selected)]' : 'text-fg-muted hover:bg-hover hover:text-fg'"
        :href="formatRoute({ name: 'worker', pid: project.id, tid: view.ticket.id })"
        :title="ticketLabel(view)"
        :aria-label="ticketLabel(view)"
        :aria-current="activeTicketId === view.ticket.id ? 'page' : undefined"
        @click="$emit('select')"
      >
        <StageGlyph :stage="view.glyph" :class="{ 'opacity-60 saturate-0': !view.attention }" />
        <span class="min-w-0 truncate">{{ view.ticket.title }}</span>
      </a>
      <button
        v-if="doneTickets.length > 0"
        type="button"
        class="flex h-7 items-center gap-1 rounded-xs px-2 text-left text-xs text-fg-subtle transition-colors hover:text-fg focus-visible:shadow-(--ring-inset) [&_.ico]:transition-transform"
        :aria-expanded="showDone"
        @click="showDone = !showDone"
      >
        <span>{{ t("Done {n}", { n: doneTickets.length }) }}</span>
        <Icon name="chevR" size="xs" :class="{ 'rotate-90': showDone }" />
      </button>
    </div>
  </div>
</template>
