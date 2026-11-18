<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { computed } from "vue";
import { t } from "../i18n.ts";
import { DISPATCH_LABEL } from "../labels.ts";
import type { DispatchAction, DispatchActionKind } from "../transcript-map.ts";
import Icon from "./Icon.vue";
import TicketRef from "./TicketRef.vue";

const props = defineProps<{
  actions: readonly DispatchAction[];
  live?: boolean;
  tickets?: readonly TicketView[];
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const summary = computed(() => {
  const by = new Map<DispatchActionKind, string[]>();
  for (const act of props.actions) {
    const id = act.ticketId ?? act.questionId ?? act.title;
    const list = by.get(act.kind) ?? [];
    if (!list.includes(id)) list.push(id);
    by.set(act.kind, list);
  }
  return [...by.entries()]
    .map(([kind, ids]) => `${DISPATCH_LABEL[kind]} ${ids.join(t("、"))}`)
    .join(" · ");
});

const hasError = computed(() => props.actions.some((a) => a.status === "err"));
const hasRunning = computed(() => props.actions.some((a) => a.status === "run"));
</script>

<template>
  <details class="proc">
    <summary>
      <Icon name="chevR" size="xs" class="chev" />
      <span class="ellipsis" :class="{ shimmer: hasRunning }">{{ summary }}</span>
      <span v-if="hasError" class="minus">· {{ t("失败") }}</span>
    </summary>
    <div class="steps">
      <div v-for="act in actions" :key="act.id" class="step">
        <div class="step-row">
          <span class="tool">{{ DISPATCH_LABEL[act.kind] }}</span>
          <TicketRef
            v-if="act.ticketId"
            :ticket-id="act.ticketId"
            :tickets="tickets"
            @open-ticket="$emit('open-ticket', $event)"
          />
          <span v-else-if="act.questionId" class="mono">{{ act.questionId }}</span>
          <span class="ellipsis">{{ act.title }}</span>
          <span v-if="act.status === 'err'" class="ms minus">{{ t("失败") }}</span>
        </div>
        <div v-if="act.detail" class="step-note">{{ act.detail }}</div>
      </div>
    </div>
  </details>
</template>
