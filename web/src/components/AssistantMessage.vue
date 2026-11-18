<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import MarkdownText from "./MarkdownText.vue";

defineProps<{
  text: string;
  streaming?: boolean;
  tickets?: readonly TicketView[];
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();
</script>

<template>
  <p v-if="streaming && text === ''" class="note"><span class="shimmer">思考中</span></p>
  <div v-else class="turn msg-ai">
    <MarkdownText
      :source="text"
      :streaming="streaming"
      :tickets="tickets"
      @open-ticket="$emit('open-ticket', $event)"
    />
  </div>
</template>
