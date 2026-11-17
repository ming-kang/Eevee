<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { computed } from "vue";
import { REPORT_LABEL, STAGE_LABEL } from "../labels.ts";

const props = defineProps<{ view: TicketView; active?: boolean }>();
defineEmits<{ open: [] }>();
const reports = computed(() => [...props.view.reports].sort((a, b) => b.seq - a.seq));
const latest = computed(() => reports.value[0]);
</script>

<template>
  <details class="ticket" :class="{ active }" :data-stage="view.stage">
    <summary>
      <div class="line">
        <span class="id muted">{{ view.ticket.id }}</span>
        <span class="name">{{ view.ticket.title }}</span>
        <span class="stage">{{ STAGE_LABEL[view.stage] }}</span>
      </div>
      <div v-if="latest" class="latest muted">
        {{ REPORT_LABEL[latest.status] }}：{{ latest.summary }}
      </div>
    </summary>
    <div class="body">
      <button type="button" class="open" @click="$emit('open')">打开对话</button>
      <p>{{ view.ticket.goal }}</p>
      <ul v-if="view.ticket.acceptance.length > 0">
        <li v-for="(a, i) in view.ticket.acceptance" :key="i">{{ a }}</li>
      </ul>
      <div v-for="r in reports" :key="r.seq" class="report">
        <span class="muted">#{{ r.seq }} {{ REPORT_LABEL[r.status] }}</span>
        {{ r.summary }}
      </div>
    </div>
  </details>
</template>

<style scoped>
.ticket {
  background: var(--ev-bg);
  border: 1px solid var(--ev-border);
  border-radius: var(--ev-radius);
  padding: 8px 10px;
}

.ticket.active {
  border-color: var(--ev-accent);
}

.open {
  float: right;
  font-size: 12px;
}

.ticket[data-stage="answer"],
.ticket[data-stage="review"],
.ticket[data-stage="blocked"] {
  border-left: 3px solid var(--ev-warn);
}

summary {
  cursor: pointer;
  list-style: none;
}

.line {
  display: flex;
  gap: 6px;
  align-items: baseline;
}

.name {
  flex: 1;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage,
.id,
.latest,
.report {
  font-size: 12px;
}

.latest {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.body {
  margin-top: 8px;
  border-top: 1px solid var(--ev-border);
  padding-top: 6px;
}

.body p,
.body ul {
  margin: 4px 0;
}
</style>
