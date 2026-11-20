<script setup lang="ts">
import type { TicketView } from "@shared/protocol/contract.ts";
import type { QuestionId } from "@shared/domain/index.ts";
import { computed } from "vue";
import { t } from "../../lib/i18n.ts";
import { DISPATCH_LABEL } from "../../lib/labels.ts";
import type { DispatchAction, DispatchActionKind } from "../../lib/transcript-map.ts";
import Icon from "../../ui/Icon.vue";
import TicketRef from "../project/TicketRef.vue";
import { STEP_NOTE, STEP_ROW, STEPS } from "./steps.ts";

const props = defineProps<{
  actions: readonly DispatchAction[];
  live?: boolean;
  tickets?: readonly TicketView[];
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
  "open-question": [questionId: QuestionId];
}>();

const summary = computed(() => {
  const by = new Map<DispatchActionKind, string[]>();
  for (const act of props.actions) {
    const id = act.ticketId ? undefined : (act.questionId ?? act.title);
    const list = by.get(act.kind) ?? [];
    if (id && !list.includes(id)) list.push(id);
    by.set(act.kind, list);
  }
  return [...by.entries()]
    .map(([kind, ids]) => ids.length ? `${DISPATCH_LABEL[kind]} ${ids.join(t(", "))}` : DISPATCH_LABEL[kind])
    .join(" · ");
});

const hasError = computed(() => props.actions.some((a) => a.status === "err"));
const hasRunning = computed(() => props.actions.some((a) => a.status === "run"));
const ticketIds = computed(() => [...new Set(props.actions.flatMap((action) => action.ticketId ? [action.ticketId] : []))]);
</script>

<template>
  <details class="proc">
    <summary>
      <Icon name="chevR" size="xs" class="chev" />
      <span class="ellipsis" :class="{ shimmer: hasRunning }">{{ summary }}</span>
      <span class="flex min-w-0 items-center gap-1 overflow-hidden">
        <TicketRef v-for="ticketId in ticketIds" :key="ticketId" :ticket-id="ticketId" :tickets="tickets" @open-ticket="$emit('open-ticket', $event)" />
      </span>
      <span v-if="hasError" class="minus">· {{ t("Failed") }}</span>
    </summary>
    <div :class="STEPS">
      <div v-for="act in actions" :key="act.id" class="step">
        <div :class="STEP_ROW">
          <span class="tool">{{ DISPATCH_LABEL[act.kind] }}</span>
          <TicketRef
            v-if="act.ticketId"
            :ticket-id="act.ticketId"
            :tickets="tickets"
            @open-ticket="$emit('open-ticket', $event)"
          />
          <button
            v-else-if="act.questionId"
            type="button"
            class="mono link"
            @click="$emit('open-question', act.questionId)"
          >
            {{ act.questionId }}
          </button>
          <span class="ellipsis">{{ act.title }}</span>
          <span v-if="act.status === 'err'" class="ms minus">{{ t("Failed") }}</span>
        </div>
        <div v-if="act.detail" :class="STEP_NOTE">{{ act.detail }}</div>
      </div>
    </div>
  </details>
</template>
