<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { computed } from "vue";
import { t } from "../../lib/i18n.ts";
import { splitTicketRefs } from "../../lib/mentions.ts";
import MessageActions from "./MessageActions.vue";
import TicketRef from "../project/TicketRef.vue";
import { MSG_META, msgUser, uWrap } from "./message.ts";

const props = withDefaults(
  defineProps<{
    text: string;
    at?: number;
    pending?: boolean;
    latest?: boolean;
    tickets?: readonly TicketView[];
  }>(),
  { tickets: () => [] },
);

defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const ids = computed(() => new Set(props.tickets.map((view) => view.ticket.id)));
/** Ticket ids the reader wrote render as the same chips assistant messages use. */
const parts = computed(() => splitTicketRefs(props.text, ids.value));
</script>

<template>
  <div :class="uWrap(pending)">
    <div v-if="pending" :class="MSG_META">{{ t("Sending") }}</div>
    <div :class="msgUser(pending)">
      <template v-for="(part, i) in parts" :key="i">
        <TicketRef
          v-if="part.kind === 'ticket'"
          :ticket-id="part.ticketId"
          :tickets="tickets"
          @open-ticket="$emit('open-ticket', $event)"
        /><template v-else>{{ part.text }}</template>
      </template>
    </div>
    <MessageActions v-if="!pending" :text="text" :at="at" :latest="latest" />
  </div>
</template>
