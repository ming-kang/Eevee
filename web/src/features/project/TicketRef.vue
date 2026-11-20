<script setup lang="ts">
import type { TicketView } from "@shared/protocol/contract.ts";
import { computed } from "vue";
import { effectiveStage } from "../../lib/board.ts";
import { STAGE_LABEL } from "../../lib/labels.ts";
import { displayId } from "../../lib/ids.ts";

const props = defineProps<{
  ticketId: string;
  label?: string;
  tickets?: readonly TicketView[];
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const tooltip = computed(() => {
  const found = props.tickets?.find((t) => t.ticket.id === props.ticketId);
  if (!found) return props.ticketId;
  return `${found.ticket.title} · ${STAGE_LABEL[effectiveStage(found)]}`;
});
</script>

<template>
  <button
    type="button"
    class="mx-px inline rounded-xs bg-[color-mix(in_oklab,var(--fg)_7%,transparent)] px-1 py-px font-mono text-[0.88em] font-medium text-fg transition-colors [box-decoration-break:clone] hover:bg-[color-mix(in_oklab,var(--fg)_13%,transparent)]"
    :title="tooltip"
    @click.stop="$emit('open-ticket', ticketId)"
  >
    {{ !label || label === ticketId ? displayId(ticketId) : label }}
  </button>
</template>
