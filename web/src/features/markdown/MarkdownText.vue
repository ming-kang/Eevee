<script setup lang="ts">
import type { TicketView } from "@shared/protocol/contract.ts";
import { computed, provide } from "vue";
import { markdownParser, TICKET_LINKS } from "../../composables/markdown.ts";
import MarkdownBlocks from "./MarkdownBlocks.vue";

const props = defineProps<{
  source: string;
  tickets?: readonly TicketView[];
  streaming?: boolean;
}>();

const emit = defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const parse = markdownParser();
const blocks = computed(() => parse(props.source, props.streaming));

provide(TICKET_LINKS, {
  tickets: () => props.tickets,
  open: (ticketId) => emit("open-ticket", ticketId),
});
</script>

<template>
  <MarkdownBlocks :blocks="blocks" :streaming="streaming" />
</template>
