<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { t } from "../../lib/i18n.ts";
import MarkdownText from "../markdown/MarkdownText.vue";
import MessageActions from "./MessageActions.vue";

defineProps<{
  text: string;
  streaming?: boolean;
  tickets?: readonly TicketView[];
  /** The turn's final message gets the action row; a streaming one never does. */
  actions?: boolean;
  at?: number;
  latest?: boolean;
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();
</script>

<template>
  <p v-if="streaming && text === ''" class="note"><span class="shimmer">{{ t("Thinking…") }}</span></p>
  <div v-else class="turn msg-ai">
    <MarkdownText
      :source="text"
      :streaming="streaming"
      :tickets="tickets"
      @open-ticket="$emit('open-ticket', $event)"
    />
    <MessageActions v-if="actions" :text="text" :at="at" :latest="latest" />
  </div>
</template>
