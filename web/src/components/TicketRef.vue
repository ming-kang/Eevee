<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { computed } from "vue";
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
  const stage =
    found.ticket.status !== "open"
      ? STAGE_LABEL[found.ticket.status]
      : STAGE_LABEL[found.stage];
  return `${found.ticket.title} · ${stage}`;
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
