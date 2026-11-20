<script setup lang="ts">
import type { TicketView } from "@shared/protocol/contract.ts";
import { computed } from "vue";
import { resolveTicketRef } from "../../lib/ticket-ref.ts";
import StageGlyph from "./StageGlyph.vue";

const props = defineProps<{
  ticketId: string;
  label?: string;
  tickets?: readonly TicketView[];
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const reference = computed(() => resolveTicketRef(props.ticketId, props.tickets, props.label));
</script>

<template>
  <button
    type="button"
    class="mx-px inline-flex items-center gap-1 rounded-xs bg-[color-mix(in_oklab,var(--fg)_7%,transparent)] px-1 py-px align-baseline font-mono text-[0.88em] font-medium text-fg transition-colors hover:bg-[color-mix(in_oklab,var(--fg)_13%,transparent)] [&_.glyph]:size-[1em]"
    :title="reference.tooltip"
    :aria-label="`${reference.label} · ${reference.tooltip}`"
    :data-ticket-id="reference.ticketId"
    @click.stop.prevent="$emit('open-ticket', reference.ticketId)"
  >
    <StageGlyph v-if="reference.stage" :stage="reference.stage" />
    {{ reference.label }}
  </button>
</template>
