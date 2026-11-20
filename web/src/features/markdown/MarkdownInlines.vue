<script setup lang="ts">
import { inject } from "vue";
import { type Inline, TICKET_LINKS } from "../../composables/markdown.ts";
import TicketRef from "../project/TicketRef.vue";

defineProps<{ items: readonly Inline[] }>();

const links = inject(TICKET_LINKS, undefined);
</script>

<template>
  <template v-for="(item, index) in items" :key="index">
    <template v-if="item.type === 'text'">{{ item.text }}</template>
    <code v-else-if="item.type === 'code'">{{ item.text }}</code>
    <component
      :is="item.type"
      v-else-if="item.type === 'strong' || item.type === 'em' || item.type === 'del'"
    >
      <MarkdownInlines :items="item.children" />
    </component>
    <a v-else-if="item.type === 'link'" :href="item.href" target="_blank" rel="noopener noreferrer">
      <MarkdownInlines :items="item.children" />
    </a>
    <TicketRef
      v-else-if="item.type === 'ticket'"
      :ticket-id="item.ticketId"
      :label="item.label"
      :tickets="links?.tickets()"
      @open-ticket="links?.open($event)"
    />
    <br v-else-if="item.type === 'break'" />
    <span v-else class="caret" />
  </template>
</template>
