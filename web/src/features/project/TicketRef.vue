<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { computed } from "vue";
import { effectiveStage } from "../board.ts";
import { STAGE_LABEL } from "../labels.ts";

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
    class="tref"
    :title="tooltip"
    @click.stop="$emit('open-ticket', ticketId)"
  >
    {{ label ?? ticketId }}
  </button>
</template>
