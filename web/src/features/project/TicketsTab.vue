<script setup lang="ts">
import type { BoardView, TicketView } from "@shared/protocol/contract.ts";
import { computed, ref } from "vue";
import { effectiveStage, type TicketGroups, ticketQuestionSummary } from "../../lib/board.ts";
import { t } from "../../lib/i18n.ts";
import { reportSummary, STAGE_LABEL } from "../../lib/labels.ts";
import Icon from "../../ui/Icon.vue";
import StageGlyph from "./StageGlyph.vue";
import { displayId } from "../../lib/ids.ts";
import { ID_TEXT, stageText } from "./stage.ts";

const props = defineProps<{
  board: BoardView | undefined;
  groups: TicketGroups;
  activeTicketId?: string;
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const showClosed = ref(false);

const openGroups = computed(() => [
  { key: "answer", label: t("Needs answer"), cls: "text-fg-subtle", stage: false, items: props.groups.answer },
  { key: "review", label: t("Needs review"), cls: "text-fg-subtle", stage: false, items: props.groups.review },
  { key: "blocked", label: t("Blocked"), cls: "text-fg-subtle", stage: false, items: props.groups.blocked },
  // Mixed stages: the per-row stage word stays so the reader can tell them apart.
  { key: "active", label: t("In progress"), cls: "text-fg-subtle", stage: true, items: props.groups.active },
]);

function latestReport(view: TicketView): TicketView["reports"][number] | undefined {
  let latest: TicketView["reports"][number] | undefined;
  for (const report of view.reports) {
    if (!latest || report.seq > latest.seq) latest = report;
  }
  return latest;
}

function rowTooltip(view: TicketView): string {
  const stage = effectiveStage(view);
  return [view.ticket.title, STAGE_LABEL[stage], latestReport(view)?.summary ?? view.ticket.closeNote]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The row's second line after the stage label: the question it waits on for `answer`, the latest
 * report otherwise, plus its running jobs when `jobs` is not already the stage.
 */
function contextLine(view: TicketView): string | undefined {
  const report = latestReport(view);
  const base =
    view.stage === "answer"
      ? ticketQuestionSummary(view.ticket.id, props.board?.openQuestions ?? [])
      : report
        ? reportSummary(report)
        : undefined;
  const running = view.jobs.filter((job) => job.status === "running").length;
  const parts = [base];
  if (running > 0 && view.stage !== "jobs") {
    parts.push(t("{n} job|{n} jobs", { n: running }));
  }
  const line = parts.filter(Boolean).join(" · ");
  return line === "" ? undefined : line;
}
</script>

<template>
  <template v-if="board && board.tickets.length === 0">
    <div class="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Icon name="layers" size="lg" class="mb-1 text-fg-subtle" />
      <h3 class="text-sm font-medium text-fg-muted">{{ t("No tickets") }}</h3>
      <p class="max-w-64 text-xs leading-5 text-fg-subtle">{{ t("Tell the Router what to do to get started.") }}</p>
    </div>
  </template>
  <template v-else-if="board">
    <template v-for="group in openGroups" :key="group.key">
      <template v-if="group.items.length > 0">
        <div class="flex h-7.5 w-full items-center gap-1 px-2.5 pt-2 text-left text-xs font-medium first:h-6 first:pt-0.5" :class="group.cls">
          <span>{{ group.label }}</span>
          <span class="ml-auto text-fg-subtle tabular-nums">{{ group.items.length }}</span>
        </div>
        <button
          v-for="view in group.items"
          :key="view.ticket.id"
          type="button"
          class="grid min-h-8 w-full grid-cols-[var(--ev-icon-sm)_minmax(0,1fr)_auto] items-baseline gap-x-2.25 gap-y-1 rounded-md px-2.5 py-2.25 text-left text-sm tracking-(--ev-tracking) transition-colors pointer-coarse:min-h-10 focus-visible:shadow-(--ring-inset) [&>.glyph]:mt-0.5 [&>.glyph]:self-start"
          :class="activeTicketId === view.ticket.id ? 'bg-selected [--ev-glyph-cut:var(--selected)]' : 'hover:bg-hover'"
          :title="rowTooltip(view)"
          @click="$emit('open-ticket', view.ticket.id)"
        >
          <StageGlyph :stage="effectiveStage(view)" />
          <span class="line-clamp-2 leading-5 wrap-anywhere">{{ view.ticket.title }}</span>
          <span :class="ID_TEXT">{{ displayId(view.ticket.id) }}</span>
          <span v-if="group.stage || contextLine(view)" class="col-span-2 col-start-2 truncate text-xs text-fg-subtle">
            <span v-if="group.stage" :class="stageText(view.stage)">{{ STAGE_LABEL[view.stage] }}</span>
            <template v-if="contextLine(view)">{{ group.stage ? " · " : "" }}{{ contextLine(view) }}</template>
          </span>
        </button>
      </template>
    </template>

    <template v-if="groups.closed.length > 0">
      <button
        type="button"
        class="flex h-7.5 w-full items-center gap-1 px-2.5 pt-2 text-left text-xs font-medium first:h-6 first:pt-0.5 rounded-sm text-fg-subtle transition-colors hover:text-fg pointer-coarse:min-h-10 [&_.chev]:transition-transform"
        :class="{ '[&_.chev]:-rotate-90': !showClosed }"
        :aria-expanded="showClosed"
        @click="showClosed = !showClosed"
      >
        <span>{{ t("Done {n}", { n: groups.closed.length }) }}</span>
        <Icon name="chevD" size="xs" class="chev" />
      </button>
      <template v-if="showClosed">
        <button
          v-for="view in groups.closed"
          :key="view.ticket.id"
          type="button"
          class="grid min-h-8 w-full grid-cols-[var(--ev-icon-sm)_minmax(0,1fr)_auto] items-baseline gap-x-2.25 gap-y-1 rounded-md px-2.5 py-2.25 text-left text-sm tracking-(--ev-tracking) transition-colors pointer-coarse:min-h-10 focus-visible:shadow-(--ring-inset) [&>.glyph]:mt-0.5 [&>.glyph]:self-start text-fg-muted"
          :class="activeTicketId === view.ticket.id ? 'bg-selected [--ev-glyph-cut:var(--selected)]' : 'hover:bg-hover'"
          :title="rowTooltip(view)"
          @click="$emit('open-ticket', view.ticket.id)"
        >
          <StageGlyph :stage="effectiveStage(view)" />
          <span class="ellipsis leading-5">{{ view.ticket.title }}</span>
          <span :class="ID_TEXT">{{ displayId(view.ticket.id) }}</span>
        </button>
      </template>
    </template>
  </template>
</template>
