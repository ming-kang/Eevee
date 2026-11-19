<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { computed } from "vue";
import type { GapItem } from "../conversation.ts";
import { t } from "../i18n.ts";
import { formatDurationMs } from "../time.ts";
import type { TranscriptDisplayItem } from "../transcript-map.ts";
import Icon from "./Icon.vue";
import TranscriptItem from "./TranscriptItem.vue";

type Worked = Extract<TranscriptDisplayItem, { kind: "worked" }>;

/**
 * A finished turn's folded work: one quiet line — how long it took and what it did — that opens
 * back into the lines it hides. Nothing inside is re-rendered differently, so an expanded group
 * looks exactly as the turn did before it folded.
 */
const props = defineProps<{
  item: Worked;
  open: boolean;
  tickets?: readonly TicketView[];
  runningJobIds?: ReadonlySet<string>;
  loadingEarlier?: boolean;
  fillingGaps?: boolean;
  retry?: () => Promise<void>;
  loadEarlier?: () => Promise<void>;
  fillGap?: (gap: GapItem) => Promise<void>;
}>();

const emit = defineEmits<{
  toggle: [];
  "open-ticket": [ticketId: string];
  "open-detail": [];
  "open-job": [jobId: string];
}>();

const label = computed(() =>
  props.item.ms === undefined
    ? t("Worked")
    : t("Worked for {duration}", { duration: formatDurationMs(props.item.ms) }),
);

const counts = computed(() => {
  const c = props.item.counts;
  const parts: string[] = [];
  if (c.tools > 0) parts.push(t("{n} step|{n} steps", { n: c.tools }));
  if (c.commands > 0) parts.push(t("{n} command|{n} commands", { n: c.commands }));
  if (c.files > 0) parts.push(t("{n} file edited|{n} files edited", { n: c.files }));
  if (c.dispatched > 0) {
    parts.push(t("{n} ticket dispatched|{n} tickets dispatched", { n: c.dispatched }));
  }
  return parts.join(" · ");
});
</script>

<template>
  <div class="worked" :class="{ open }">
    <button type="button" class="worked-h" :aria-expanded="open" @click="emit('toggle')">
      <span class="ellipsis">{{ label }}</span>
      <span v-if="counts" class="worked-c ellipsis">{{ counts }}</span>
      <Icon name="chevR" size="xs" class="chev" />
    </button>
    <template v-if="open">
      <TranscriptItem
        v-for="child in item.items"
        :key="child.key"
        :item="child"
        :tickets="tickets"
        :running-job-ids="runningJobIds"
        :loading-earlier="loadingEarlier"
        :filling-gaps="fillingGaps"
        :retry="retry"
        :load-earlier="loadEarlier"
        :fill-gap="fillGap"
        @open-ticket="$emit('open-ticket', $event)"
        @open-detail="$emit('open-detail')"
        @open-job="$emit('open-job', $event)"
      />
    </template>
  </div>
</template>
