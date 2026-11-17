<script setup lang="ts">
import type { BoardView, TicketView } from "@shared/api/contract.ts";
import { STAGE_NEEDS } from "@shared/contracts/index.ts";
import { computed } from "vue";
import TicketCard from "./TicketCard.vue";

const props = defineProps<{
  board: BoardView | undefined;
  error: string | undefined;
  active?: string | undefined;
}>();
defineEmits<{ open: [ticketId: string] }>();

const groups = computed(() => {
  const tickets = props.board?.tickets ?? [];
  const by = (needs: "user" | "router" | null) =>
    tickets.filter((t: TicketView) => STAGE_NEEDS[t.stage] === needs);
  return [
    { title: "等你处理", tickets: by("user") },
    { title: "等 Router 处理", tickets: by("router") },
    { title: "其他", tickets: by(null) },
  ].filter((group) => group.tickets.length > 0);
});
</script>

<template>
  <aside class="rail">
    <header class="title">工单</header>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="board && groups.length === 0" class="muted">还没有工单。</p>
    <section v-for="group in groups" :key="group.title" class="group">
      <div class="group-title muted">{{ group.title }} · {{ group.tickets.length }}</div>
      <TicketCard
        v-for="view in group.tickets"
        :key="view.ticket.id"
        :view="view"
        :active="view.ticket.id === active"
        @open="$emit('open', view.ticket.id)"
      />
    </section>
  </aside>
</template>

<style scoped>
.rail {
  border-left: 1px solid var(--ev-border);
  background: var(--ev-bg-sidebar);
  padding: 12px 14px;
  overflow-y: auto;
}

.title {
  font-weight: 600;
  margin-bottom: 8px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.group-title {
  font-size: 12px;
}
</style>
