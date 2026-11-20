<script setup lang="ts">
import type { QuestionId } from "@shared/domain/index.ts";
import type { TicketView } from "@shared/protocol/contract.ts";
import { computed, nextTick, ref } from "vue";
import { activityLabel, editSummary } from "../../lib/activity.ts";
import { fold } from "../../composables/folds.ts";
import { t } from "../../lib/i18n.ts";
import { formatDurationMs } from "../../lib/time.ts";
import type { TranscriptDisplayItem } from "../../lib/transcript-map.ts";
import { closedItems } from "../../lib/turns.ts";
import Icon from "../../ui/Icon.vue";
import TranscriptItem from "./TranscriptItem.vue";
import { DIFFSTAT } from "../../ui/diff.ts";

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
  <div ref="root" class="worked group/worked">
    <button
      type="button"
      class="group/wh -ml-1.5 flex min-h-6.5 w-fit max-w-full items-center gap-1.75 rounded-sm px-1.5 py-0.75 text-left text-sm leading-[1.385] transition-colors hover:text-fg focus-visible:shadow-(--ring-inset)"
      :class="open ? 'text-fg' : 'text-fg-muted'"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="ellipsis">{{ label }}</span>
      <span v-if="counts" class="ellipsis text-fg-subtle">{{ counts }}</span>
      <Icon
        name="chevR"
        size="xs"
        class="text-fg-subtle transition-[opacity,transform]"
        :class="open ? 'rotate-90' : 'opacity-0 group-hover/worked:opacity-100 group-focus-visible/wh:opacity-100 [@media(hover:none)]:opacity-100'"
      />
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
    <div v-if="!open && summary" class="mt-px ml-1.5">
      <button
        type="button"
        class="-ml-1.5 flex min-h-5.5 max-w-full items-center gap-1.75 rounded-sm px-1.5 py-0.5 text-xs text-fg-subtle transition-colors hover:text-fg focus-visible:text-fg [&_.minus]:ml-1 [&_.minus]:font-mono [&_.plus]:ml-1 [&_.plus]:font-mono"
        :aria-expanded="pathsOpen"
        @click="pathsOpen = !pathsOpen"
      >
        <span class="ellipsis">
          {{ t("Edited {n} file|Edited {n} files", { n: summary.files }) }}
          <span class="plus">+{{ summary.added }}</span>
          <span class="minus">−{{ summary.removed }}</span>
        </span>
        <Icon name="chevR" size="xs" class="text-fg-subtle transition-transform" :class="{ 'rotate-90': pathsOpen }" />
      </button>
      <div v-if="pathsOpen" class="mt-0.5 mb-1 ml-2.5 flex flex-col gap-px animate-[ev-fade_var(--ev-regular)_var(--ev-ease)]">
        <button
          v-for="p in summary.paths"
          :key="p.key"
          type="button"
          class="flex min-h-5.5 max-w-full items-center gap-2 rounded-xs px-1.5 py-0.5 text-left text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg"
          @click="reveal(p.key)"
        >
          <span class="mono ellipsis">{{ p.path }}</span>
          <span :class="DIFFSTAT">
            <span v-if="p.added > 0" class="plus">+{{ p.added }}</span>
            <span v-if="p.removed > 0" class="minus">−{{ p.removed }}</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
