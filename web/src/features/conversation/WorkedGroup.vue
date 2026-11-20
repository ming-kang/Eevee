<script setup lang="ts">
import type { QuestionId } from "@shared/contracts/index.ts";
import type { TicketView } from "@shared/api/contract.ts";
import { computed, nextTick, ref } from "vue";
import { activityLabel, editSummary } from "../activity.ts";
import { fold } from "../folds.ts";
import { t } from "../i18n.ts";
import { formatDurationMs } from "../time.ts";
import type { TranscriptDisplayItem } from "../transcript-map.ts";
import { closedItems } from "../turns.ts";
import Icon from "./Icon.vue";
import TranscriptItem from "./TranscriptItem.vue";

type Worked = Extract<TranscriptDisplayItem, { kind: "worked" }>;

/**
 * A finished turn's folded work: one quiet line — how long it took and what it did — under which
 * the turn's replies and dispatches stay readable. Open, it shows every line the turn wrote,
 * exactly as it did before it folded. The reader's open/closed choice is remembered per
 * conversation through `foldScope`.
 */
const props = withDefaults(
  defineProps<{
    item: Worked;
    /** The conversation's fold-memory scope: persisted open/closed choices key off it. */
    foldScope?: string;
    /** Keys of each turn's last assistant message, which earns the action row. */
    finalKeys?: ReadonlySet<string>;
    /** Keys of the newest turn's lines; touch pointers keep their actions visible. */
    latestKeys?: ReadonlySet<string>;
    tickets?: readonly TicketView[];
    runningJobIds?: ReadonlySet<string>;
  }>(),
  {
    foldScope: "",
    finalKeys: () => new Set<string>(),
    latestKeys: () => new Set<string>(),
    tickets: () => [],
    runningJobIds: () => new Set<string>(),
  },
);

const emit = defineEmits<{
  "open-ticket": [ticketId: string];
  "open-detail": [];
  "open-job": [jobId: string];
  "open-question": [questionId: QuestionId];
}>();

const open = fold(() => `${props.foldScope}|${props.item.key}`, false);

const label = computed(() =>
  props.item.ms === undefined
    ? t("Worked")
    : t("Worked for {duration}", { duration: formatDurationMs(props.item.ms) }),
);

const counts = computed(() => activityLabel(props.item.activity));

/** Closed shows the replies and dispatches; open shows the turn exactly as it ran. */
const shown = computed(() => (open.value ? props.item.items : closedItems(props.item)));

// ——— Worker turns: the files a folded turn changed ———

const summary = computed(() => editSummary(props.item.items));
const pathsOpen = ref(false);
const root = ref<HTMLElement>();

/** Reveal a path's edit inside the group and light it up for a moment. */
async function reveal(key: string): Promise<void> {
  open.value = true;
  await nextTick();
  const el = root.value?.querySelector<HTMLElement>(`[data-edit-key="${CSS.escape(key)}"]`);
  if (el === null || el === undefined) return;
  el.scrollIntoView({ block: "center" });
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), 1200);
}
</script>

<template>
  <div ref="root" class="worked" :class="{ open }">
    <button type="button" class="worked-h" :aria-expanded="open" @click="open = !open">
      <span class="ellipsis">{{ label }}</span>
      <span v-if="counts" class="worked-c ellipsis">{{ counts }}</span>
      <Icon name="chevR" size="xs" class="chev" />
    </button>
    <TranscriptItem
      v-for="child in shown"
      :key="child.key"
      :item="child"
      :tickets="tickets"
      :running-job-ids="runningJobIds"
      :turn-final="child.kind === 'assistant' && finalKeys.has(child.key)"
      :latest="latestKeys.has(child.key)"
      :fold-scope="foldScope"
      @open-ticket="emit('open-ticket', $event)"
      @open-detail="emit('open-detail')"
      @open-job="emit('open-job', $event)"
      @open-question="emit('open-question', $event)"
    />
    <div v-if="!open && summary" class="worked-files">
      <button
        type="button"
        class="worked-files-h"
        :aria-expanded="pathsOpen"
        @click="pathsOpen = !pathsOpen"
      >
        <span class="ellipsis">
          {{ t("Edited {n} file|Edited {n} files", { n: summary.files }) }}
          <span class="plus">+{{ summary.added }}</span>
          <span class="minus">−{{ summary.removed }}</span>
        </span>
        <Icon name="chevR" size="xs" class="chev" :class="{ open: pathsOpen }" />
      </button>
      <div v-if="pathsOpen" class="worked-files-list">
        <button
          v-for="p in summary.paths"
          :key="p.key"
          type="button"
          class="worked-file"
          @click="reveal(p.key)"
        >
          <span class="mono ellipsis">{{ p.path }}</span>
          <span class="diffstat">
            <span v-if="p.added > 0" class="plus">+{{ p.added }}</span>
            <span v-if="p.removed > 0" class="minus">−{{ p.removed }}</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
