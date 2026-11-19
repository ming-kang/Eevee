<script setup lang="ts">
import type { QuestionId } from "@shared/contracts/index.ts";
import type { TicketView } from "@shared/api/contract.ts";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useComposerInsert } from "../composer-bridge.ts";
import type { GapItem } from "../conversation.ts";
import { type FollowEnd, followEnd, isSashDragging, onSashDragEnd } from "../dom.ts";
import { folds } from "../folds.ts";
import { t } from "../i18n.ts";
import { activeEntry, outlineEntries } from "../outline.ts";
import { quoteMarkdown } from "../quote.ts";
import { formatWorkingClock } from "../time.ts";
import { type TranscriptDisplayItem } from "../transcript-map.ts";
import { finalAssistantKeys, foldTurns } from "../turns.ts";
import ConversationOutline from "./ConversationOutline.vue";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";
import TranscriptItem from "./TranscriptItem.vue";
import WorkedGroup from "./WorkedGroup.vue";

const props = withDefaults(
  defineProps<{
    items: readonly TranscriptDisplayItem[];
    tickets?: readonly TicketView[];
    runningJobIds?: ReadonlySet<string>;
    /** The conversation is mid-run: the newest turn never folds. */
    running?: boolean;
    /** The conversation's fold-memory scope ("r:<pid>" or "w:<pid>:<ticket>"), "" means forget. */
    foldScope?: string;
    loadingEarlier?: boolean;
    fillingGaps?: boolean;
    retry?: () => Promise<void>;
    loadEarlier?: () => Promise<void>;
    fillGap?: (gap: GapItem) => Promise<void>;
  }>(),
  {
    tickets: () => [],
    runningJobIds: () => new Set<string>(),
    running: false,
    foldScope: "",
    loadingEarlier: false,
    fillingGaps: false,
    retry: undefined,
    loadEarlier: undefined,
    fillGap: undefined,
  },
);

defineEmits<{
  "open-ticket": [ticketId: string];
  "open-detail": [];
  "open-job": [jobId: string];
  "open-question": [questionId: QuestionId];
}>();

const scroller = ref<HTMLElement>();

/** Finished turns folded to their "Worked for …" lines; work still underway stays open. */
const displayItems = computed(() => foldTurns(props.items, props.running));

/** The last assistant message of each turn: it earns the copy/time action row. */
const turnFinal = computed(() => finalAssistantKeys(displayItems.value));

/** Lines in the newest turn; touch pointers keep their action rows visible. */
const latestKeys = computed(() => {
  const keys = new Set<string>();
  let start = 0;
  for (const [i, item] of displayItems.value.entries()) {
    if (item.kind === "user" || item.kind === "qa" || item.kind === "event") start = i;
  }
  for (const [i, item] of displayItems.value.entries()) {
    if (i < start) continue;
    keys.add(item.key);
    if (item.kind === "worked") for (const c of item.items) keys.add(c.key);
  }
  return keys;
});

const tailKey = computed(() => {
  const last = props.items.at(-1);
  if (!last) return "";
  if (last.kind === "assistant") return `${last.key}:${last.text.length}`;
  if (last.kind === "tools") return `${last.key}:${last.steps.map((s) => `${s.status}:${s.output?.length ?? 0}`).join(",")}`;
  if (last.kind === "bash") return `${last.key}:${last.status}:${last.output.length}`;
  return last.key;
});

/**
 * Whether the view keeps to the newest line. Only the reader's own scrolling changes it: content growing
 * underneath never does, so a long tool output that lands while the view is at the end is followed, and
 * one that lands while the reader is further up leaves them where they are.
 */
const following = ref(true);
let follow: FollowEnd | undefined;

/** Something is being written at the end right now. */
const live = computed(() => {
  const last = props.items.at(-1);
  if (!last) return false;
  if (last.kind === "assistant" || last.kind === "thinking") return last.streaming === true;
  if (last.kind === "tools" || last.kind === "dispatch") return last.live === true;
  return last.kind === "bash" && last.status === "run";
});

// ——— The running clock: how long the current turn has been at it ———

const nowMs = ref(Date.now());
let firstSeenRunning = 0;
let clockTimer: number | undefined;

watch(
  () => props.running,
  (on) => {
    if (clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
    if (on) {
      if (firstSeenRunning === 0) firstSeenRunning = Date.now();
      nowMs.value = Date.now();
      clockTimer = window.setInterval(() => {
        nowMs.value = Date.now();
      }, 1000);
    } else {
      firstSeenRunning = 0;
    }
  },
  { immediate: true },
);

/** The turn's start: its inbound line's time, else the moment the run was first seen. */
const workingClock = computed(() => {
  if (!props.running) return "";
  let start = firstSeenRunning;
  for (const item of [...props.items].reverse()) {
    if (
      (item.kind === "user" || item.kind === "qa" || item.kind === "event") &&
      item.at !== undefined
    ) {
      start = item.at;
      break;
    }
  }
  return formatWorkingClock((nowMs.value - start) / 1000);
});

/** Back to the newest line, gliding unless the reader asked for less motion. */
function toLatest(): void {
  const el = scroller.value;
  if (!el || follow === undefined) return;
  follow.following = true;
  following.value = true;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
}

// ——— Conversation outline: one tick per thing the reader said ———

const outline = computed(() => outlineEntries(displayItems.value));
const tops = ref<number[]>([]);
const totalHeight = ref(1);
const activeIdx = ref(-1);

/** Tick positions 0–1 down the conversation, nudged apart so crowded entries stay readable. */
const outlineTicks = computed(() => {
  const total = totalHeight.value;
  const GAP = 0.018;
  let prev = -GAP;
  return tops.value.map((top) => {
    const pct = Math.min(1, Math.max(Number.isFinite(top) ? top / total : 1, prev + GAP));
    prev = pct;
    return pct;
  });
});

function updateActive(): void {
  const el = scroller.value;
  if (el === undefined) return;
  activeIdx.value = activeEntry(tops.value, el.scrollTop, Math.min(160, el.clientHeight * 0.35));
}

function measureOutline(): void {
  const el = scroller.value;
  if (el === undefined) return;
  const sRect = el.getBoundingClientRect();
  tops.value = outline.value.map((entry) => {
    const node = el.querySelector<HTMLElement>(`[data-outline-key="${CSS.escape(entry.key)}"]`);
    if (node === null) return Number.POSITIVE_INFINITY;
    return node.getBoundingClientRect().top - sRect.top + el.scrollTop;
  });
  totalHeight.value = Math.max(1, el.scrollHeight);
  updateActive();
}

/**
 * Column sashes resize the chat every frame they run; the geometry read coalesces to one per
 * frame and skips the drag entirely — `onSashDragEnd` asks for the one measure it deferred.
 */
let outlineRaf = 0;

function queueMeasure(): void {
  if (isSashDragging() || outlineRaf !== 0) return;
  outlineRaf = requestAnimationFrame(() => {
    outlineRaf = 0;
    measureOutline();
  });
}

function jumpTo(key: string): void {
  const el = scroller.value;
  if (el === undefined) return;
  const node = el.querySelector<HTMLElement>(`[data-outline-key="${CSS.escape(key)}"]`);
  if (node === null) return;
  if (follow !== undefined) follow.following = false;
  following.value = false;
  const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 20;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
}

// ——— Quote a selection into the composer ———

const bridge = useComposerInsert();
const quoteBtn = ref<{ left: number; top: number }>();
let quoteText = "";
const QUOTE_HOST = ".msg-ai, .msg-user, .step-out, .tsheet";

function onSelectionChange(): void {
  const el = scroller.value;
  quoteBtn.value = undefined;
  const sel = window.getSelection();
  if (el === undefined || sel === null || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const host = (
    container instanceof Element ? container : container.parentElement
  )?.closest(QUOTE_HOST);
  if (
    host === null ||
    host === undefined ||
    !el.contains(host) ||
    host.closest(".chat-inner") === null
  ) {
    return;
  }
  const text = sel.toString();
  if (text.trim() === "") return;
  const rect = range.getClientRects()[0];
  if (rect === undefined) return;
  const sRect = el.getBoundingClientRect();
  let top = rect.top - sRect.top + el.scrollTop - 36;
  if (top < el.scrollTop + 8) top = rect.bottom - sRect.top + el.scrollTop + 8;
  quoteText = text;
  quoteBtn.value = {
    left: Math.min(Math.max(rect.left - sRect.left + rect.width / 2, 48), el.clientWidth - 48),
    top,
  };
}

function hideQuote(): void {
  quoteBtn.value = undefined;
}

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") hideQuote();
}

function insertQuote(): void {
  if (quoteText === "") return;
  bridge?.insert(quoteMarkdown(quoteText));
  quoteText = "";
  hideQuote();
  window.getSelection()?.removeAllRanges();
}

/**
 * Scrolling re-derives the quote button from the live selection: it slides with its text while
 * the selection holds, and vanishes once the selection collapses or leaves the transcript.
 */
function onScroll(): void {
  updateActive();
  onSelectionChange();
}

let resizeObs: ResizeObserver | undefined;
let offSashEnd: (() => void) | undefined;

onMounted(() => {
  const el = scroller.value;
  if (el === undefined) return;
  follow = followEnd(el, (yes) => {
    following.value = yes;
  });
  el.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("keydown", onDocKeydown);
  resizeObs = new ResizeObserver(queueMeasure);
  resizeObs.observe(el);
  offSashEnd = onSashDragEnd(() => void nextTick(measureOutline));
  void nextTick(measureOutline);
});

onUnmounted(() => {
  follow?.detach();
  scroller.value?.removeEventListener("scroll", onScroll);
  document.removeEventListener("selectionchange", onSelectionChange);
  document.removeEventListener("keydown", onDocKeydown);
  resizeObs?.disconnect();
  offSashEnd?.();
  if (outlineRaf !== 0) cancelAnimationFrame(outlineRaf);
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
});

watch(tailKey, async () => {
  if (!following.value) return;
  await nextTick();
  follow?.toEnd();
});

watch(displayItems, async () => {
  await nextTick();
  measureOutline();
});

// A fold opening or closing shifts every tick below it.
watch(
  () => folds.revision,
  async () => {
    await nextTick();
    measureOutline();
  },
);
</script>

<template>
  <div ref="scroller" class="chat">
    <div v-if="outline.length >= 3" class="outline-dock">
      <ConversationOutline
        :entries="outline"
        :ticks="outlineTicks"
        :active="activeIdx"
        @pick="jumpTo"
      />
    </div>
    <div class="chat-inner">
      <template v-for="item in displayItems" :key="item.key">
        <WorkedGroup
          v-if="item.kind === 'worked'"
          :item="item"
          :fold-scope="foldScope"
          :final-keys="turnFinal"
          :latest-keys="latestKeys"
          :tickets="tickets"
          :running-job-ids="runningJobIds"
          @open-ticket="$emit('open-ticket', $event)"
          @open-detail="$emit('open-detail')"
          @open-job="$emit('open-job', $event)"
          @open-question="$emit('open-question', $event)"
        />
        <TranscriptItem
          v-else
          :item="item"
          :tickets="tickets"
          :running-job-ids="runningJobIds"
          :loading-earlier="loadingEarlier"
          :filling-gaps="fillingGaps"
          :retry="retry"
          :load-earlier="loadEarlier"
          :fill-gap="fillGap"
          :turn-final="item.kind === 'assistant' && turnFinal.has(item.key)"
          :latest="latestKeys.has(item.key)"
          :fold-scope="foldScope"
          @open-ticket="$emit('open-ticket', $event)"
          @open-detail="$emit('open-detail')"
          @open-job="$emit('open-job', $event)"
          @open-question="$emit('open-question', $event)"
        />
      </template>
      <div v-if="running" class="turn-working">
        <StageGlyph stage="working" />
        <span>{{ t("Working") }} · {{ workingClock }}</span>
      </div>
      <slot name="tail" />
    </div>
    <button
      v-if="quoteBtn"
      type="button"
      class="quote-btn"
      :style="{ left: `${quoteBtn.left}px`, top: `${quoteBtn.top}px` }"
      @mousedown.prevent
      @click="insertQuote"
    >
      {{ t("Quote") }}
    </button>
    <div class="to-latest-dock">
      <Transition name="to-latest">
        <button
          v-if="!following"
          type="button"
          class="to-latest"
          :class="{ live }"
          :aria-label="t('Jump to latest')"
          @click="toLatest"
        >
          <StageGlyph v-if="live" stage="working" />
          <Icon name="chevD" size="sm" />
        </button>
      </Transition>
    </div>
  </div>
</template>
