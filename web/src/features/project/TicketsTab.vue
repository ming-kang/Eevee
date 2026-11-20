<script setup lang="ts">
import type { BoardView, TicketView } from "@shared/api/contract.ts";
import { computed, ref } from "vue";
import { effectiveStage, type TicketGroups, ticketQuestionSummary } from "../board.ts";
import { t } from "../i18n.ts";
import { reportSummary, STAGE_LABEL } from "../labels.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";

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
  { key: "answer", label: t("Needs answer"), cls: "user", stage: false, items: props.groups.answer },
  { key: "review", label: t("Needs review"), cls: "", stage: false, items: props.groups.review },
  { key: "blocked", label: t("Blocked"), cls: "bad", stage: false, items: props.groups.blocked },
  // Mixed stages: the per-row stage word stays so the reader can tell them apart.
  { key: "active", label: t("In progress"), cls: "", stage: true, items: props.groups.active },
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
    <p class="rail-empty">{{ t("No tickets") }}</p>
  </template>
  <template v-else-if="board">
    <template v-for="group in openGroups" :key="group.key">
      <template v-if="group.items.length > 0">
        <div class="group-h" :class="group.cls">
          <span>{{ group.label }}</span>
          <span class="n">{{ group.items.length }}</span>
        </div>
        <button
          v-for="view in group.items"
          :key="view.ticket.id"
          type="button"
          class="strip"
          :class="{ on: activeTicketId === view.ticket.id }"
          :title="rowTooltip(view)"
          @click="$emit('open-ticket', view.ticket.id)"
        >
          <StageGlyph :stage="effectiveStage(view)" />
          <span class="ticket-title">{{ view.ticket.title }}</span>
          <span class="t-id">{{ view.ticket.id }}</span>
          <span v-if="group.stage || contextLine(view)" class="t-line">
            <span v-if="group.stage" class="t-stage" :class="`s-${view.stage}`">{{ STAGE_LABEL[view.stage] }}</span>
            <template v-if="contextLine(view)">{{ group.stage ? " · " : "" }}{{ contextLine(view) }}</template>
          </span>
        </button>
      </template>
    </template>

    <template v-if="groups.closed.length > 0">
      <button
        type="button"
        class="group-h"
        :class="{ closed: !showClosed }"
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
          class="strip closed"
          :class="{ on: activeTicketId === view.ticket.id }"
          :title="rowTooltip(view)"
          @click="$emit('open-ticket', view.ticket.id)"
        >
          <StageGlyph :stage="effectiveStage(view)" />
          <span class="ellipsis">{{ view.ticket.title }}</span>
          <span class="t-id">{{ view.ticket.id }}</span>
        </button>
      </template>
    </template>
  </template>
</template>
