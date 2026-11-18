<script setup lang="ts">
import type { BoardView, TicketView } from "@shared/api/contract.ts";
import { ref } from "vue";
import { effectiveStage, type TicketGroups, ticketQuestionSummary } from "../board.ts";
import { STAGE_LABEL } from "../labels.ts";
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

function latestSummary(view: TicketView): string | undefined {
  let latest: TicketView["reports"][number] | undefined;
  for (const report of view.reports) {
    if (!latest || report.seq > latest.seq) latest = report;
  }
  return latest?.summary;
}

function rowTooltip(view: TicketView): string {
  const stage = effectiveStage(view);
  return [STAGE_LABEL[stage], latestSummary(view) ?? view.ticket.closeNote]
    .filter(Boolean)
    .join(" · ");
}

function questionLine(view: TicketView): string | undefined {
  if (view.ticket.status !== "open" || view.stage !== "answer") return undefined;
  return ticketQuestionSummary(view.ticket.id, props.board?.openQuestions ?? []);
}
</script>

<template>
  <template v-if="board && board.tickets.length === 0">
    <p class="rail-empty">没有工单</p>
  </template>
  <template v-else-if="board">
    <template v-if="groups.answer.length > 0">
      <div class="group-h user">需要你</div>
      <button
        v-for="view in groups.answer"
        :key="view.ticket.id"
        type="button"
        class="strip"
        :class="{ on: activeTicketId === view.ticket.id }"
        :title="rowTooltip(view)"
        @click="$emit('open-ticket', view.ticket.id)"
      >
        <StageGlyph :stage="effectiveStage(view)" />
        <span class="t-title">
          <span class="t-id">{{ view.ticket.id }}</span>
          <span class="ellipsis">{{ view.ticket.title }}</span>
        </span>
        <span class="t-stage s-answer">{{ STAGE_LABEL.answer }}</span>
        <span v-if="questionLine(view)" class="t-line">{{ questionLine(view) }}</span>
      </button>
    </template>

    <template v-if="groups.active.length > 0">
      <div class="group-h">进行中</div>
      <button
        v-for="view in groups.active"
        :key="view.ticket.id"
        type="button"
        class="strip"
        :class="{ on: activeTicketId === view.ticket.id }"
        :title="rowTooltip(view)"
        @click="$emit('open-ticket', view.ticket.id)"
      >
        <StageGlyph :stage="effectiveStage(view)" />
        <span class="t-title">
          <span class="t-id">{{ view.ticket.id }}</span>
          <span class="ellipsis">{{ view.ticket.title }}</span>
        </span>
        <span class="t-stage" :class="`s-${view.stage}`">{{ STAGE_LABEL[view.stage] }}</span>
      </button>
    </template>

    <template v-if="groups.closed.length > 0">
      <button
        type="button"
        class="group-h"
        :class="{ closed: !showClosed }"
        :aria-expanded="showClosed"
        @click="showClosed = !showClosed"
      >
        <span>已结单 {{ groups.closed.length }}</span>
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
          <span class="t-title">
            <span class="t-id">{{ view.ticket.id }}</span>
            <span class="ellipsis">{{ view.ticket.title }}</span>
          </span>
        </button>
      </template>
    </template>
  </template>
</template>
