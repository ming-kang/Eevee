<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { computed } from "vue";
import { type InlineNode, parseMarkdown } from "../markdown.ts";
import TicketRef from "./TicketRef.vue";

const props = defineProps<{
  source: string;
  tickets?: readonly TicketView[];
  streaming?: boolean;
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const blocks = computed(() => parseMarkdown(props.source));

function splitLines(nodes: readonly InlineNode[]): InlineNode[][] {
  const rows: InlineNode[][] = [[]];
  for (const node of nodes) {
    if (node.kind === "text" && node.text.includes("\n")) {
      const parts = node.text.split("\n");
      parts.forEach((part, idx) => {
        if (idx > 0) rows.push([]);
        if (part !== "") rows[rows.length - 1]?.push({ kind: "text", text: part });
      });
    } else {
      rows[rows.length - 1]?.push(node);
    }
  }
  return rows;
}
</script>

<template>
  <template v-for="(block, bIdx) in blocks" :key="bIdx">
    <p v-if="block.kind === 'paragraph'">
      <template v-for="(row, rIdx) in splitLines(block.inlines)" :key="rIdx">
        <br v-if="rIdx > 0" />
        <template v-for="(node, nIdx) in row" :key="nIdx">
          <template v-if="node.kind === 'text'">{{ node.text }}</template>
          <code v-else-if="node.kind === 'code'">{{ node.text }}</code>
          <TicketRef
            v-else-if="node.kind === 'tref'"
            :ticket-id="node.ticketId"
            :label="node.label"
            :tickets="tickets"
            @open-ticket="$emit('open-ticket', $event)"
          />
          <strong v-else>
            <template v-for="(child, cIdx) in node.children" :key="cIdx">
              <template v-if="child.kind === 'text'">{{ child.text }}</template>
              <code v-else-if="child.kind === 'code'">{{ child.text }}</code>
              <TicketRef
                v-else-if="child.kind === 'tref'"
                :ticket-id="child.ticketId"
                :label="child.label"
                :tickets="tickets"
                @open-ticket="$emit('open-ticket', $event)"
              />
            </template>
          </strong>
        </template>
      </template>
      <span v-if="streaming && bIdx === blocks.length - 1" class="caret" />
    </p>
    <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'">
      <li v-for="(item, iIdx) in block.items" :key="iIdx">
        <template v-for="(node, nIdx) in item" :key="nIdx">
          <template v-if="node.kind === 'text'">{{ node.text }}</template>
          <code v-else-if="node.kind === 'code'">{{ node.text }}</code>
          <TicketRef
            v-else-if="node.kind === 'tref'"
            :ticket-id="node.ticketId"
            :label="node.label"
            :tickets="tickets"
            @open-ticket="$emit('open-ticket', $event)"
          />
          <strong v-else>
            <template v-for="(child, cIdx) in node.children" :key="cIdx">
              <template v-if="child.kind === 'text'">{{ child.text }}</template>
              <code v-else-if="child.kind === 'code'">{{ child.text }}</code>
              <TicketRef
                v-else-if="child.kind === 'tref'"
                :ticket-id="child.ticketId"
                :label="child.label"
                :tickets="tickets"
                @open-ticket="$emit('open-ticket', $event)"
              />
            </template>
          </strong>
        </template>
      </li>
      <span v-if="streaming && bIdx === blocks.length - 1" class="caret" />
    </component>
    <pre v-else><code>{{ block.text }}</code></pre>
  </template>
  <span v-if="streaming && blocks.length === 0" class="caret" />
</template>
