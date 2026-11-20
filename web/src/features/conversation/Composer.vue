<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { effectiveStage } from "../board.ts";
import { type InsertAt, useComposerInsert } from "../composer-bridge.ts";
import { readDraft, saveDraft } from "../composer-draft.ts";
import { t } from "../i18n.ts";
import { doublePressed } from "../keyboard.ts";
import { mentionQuery, rankTickets } from "../mentions.ts";
import { useSubmit } from "../submit.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";

const props = withDefaults(
  defineProps<{
    send: (text: string) => Promise<void>;
    placeholder?: string;
    draftKey?: string;
    disabled?: boolean;
    /** Called when Escape is pressed twice quickly while a turn runs; omitted when nothing runs. */
    stop?: () => void;
    /** Tickets "@…" can mention; their ids render as references once sent. */
    tickets?: readonly TicketView[];
  }>(),
  {
    placeholder: t("Tell the Router what to do"),
    draftKey: "",
    disabled: false,
    stop: undefined,
    tickets: () => [],
  },
);

/** When the previous Escape landed, for the double-press stop. */
const lastEsc = ref<number>();

const text = ref(readDraft(props.draftKey));
const textarea = ref<HTMLTextAreaElement>();
const { busy, error, run } = useSubmit();
const listId = useId();

/** Where the caret sits now; where it sat last, for inserts that arrive while unfocused. */
const caret = ref(0);
const lastCaret = ref<number>();

function syncCaret(): void {
  const el = textarea.value;
  if (el === null || el === undefined) return;
  caret.value = el.selectionStart;
  lastCaret.value = el.selectionStart;
}

function autosize(): void {
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(220, el.scrollHeight)}px`;
}

// ——— @ticket mentions ———

const mention = computed(() => mentionQuery(text.value, caret.value));
const matches = computed(() =>
  mention.value === undefined ? [] : rankTickets(props.tickets, mention.value.query),
);
const selIdx = ref(0);
/** The mention dismissed with Escape stays closed until the query changes. */
const dismissed = ref<string>();
const mentionOpen = computed(() => {
  const m = mention.value;
  return (
    m !== undefined && matches.value.length > 0 && dismissed.value !== `${m.start}:${m.query}`
  );
});
const sel = computed(() =>
  Math.min(selIdx.value, Math.max(0, matches.value.length - 1)),
);

watch(mention, (next, prev) => {
  if (next?.start !== prev?.start) selIdx.value = 0;
});

function insertMention(view: TicketView): void {
  const m = mention.value;
  if (m === undefined) return;
  const id = view.ticket.id;
  text.value = `${text.value.slice(0, m.start)}${id} ${text.value.slice(caret.value)}`;
  const pos = m.start + id.length + 1;
  caret.value = pos;
  lastCaret.value = pos;
  void nextTick(() => {
    textarea.value?.focus();
    textarea.value?.setSelectionRange(pos, pos);
  });
}

// ——— Inserted text (e.g. a quoted selection from the transcript) ———

const bridge = useComposerInsert();

function insertSnippet(snippet: string, at: InsertAt = "caret"): void {
  if (at === "start") {
    const draft = text.value;
    text.value = draft === "" ? snippet : `${snippet}\n\n${draft}`;
    const caretPos = snippet.length;
    caret.value = caretPos;
    lastCaret.value = caretPos;
    void nextTick(() => {
      textarea.value?.focus();
      textarea.value?.setSelectionRange(caretPos, caretPos);
    });
    return;
  }
  const pos = Math.min(lastCaret.value ?? text.value.length, text.value.length);
  const before = text.value.slice(0, pos);
  const lead = before !== "" && !before.endsWith("\n") ? "\n" : "";
  text.value = `${before}${lead}${snippet}${text.value.slice(pos)}`;
  const caretPos = pos + lead.length + snippet.length;
  caret.value = caretPos;
  lastCaret.value = caretPos;
  void nextTick(() => {
    textarea.value?.focus();
    textarea.value?.setSelectionRange(caretPos, caretPos);
  });
}

watch(
  () => props.draftKey,
  async (nextKey) => {
    text.value = readDraft(nextKey);
    lastCaret.value = undefined;
    dismissed.value = undefined;
    await nextTick();
    autosize();
  },
);

watch(text, (val) => {
  saveDraft(props.draftKey, val);
  void nextTick(autosize);
});

onMounted(() => {
  autosize();
  bridge?.setInserter(insertSnippet);
});

onUnmounted(() => bridge?.setInserter(undefined));

async function submit(): Promise<void> {
  const value = text.value.trim();
  if (value === "" || props.disabled) return;
  if (await run(() => props.send(value))) {
    text.value = "";
    saveDraft(props.draftKey, "");
    lastCaret.value = undefined;
    await nextTick();
    autosize();
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (mentionOpen.value) {
    const count = matches.value.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selIdx.value = (sel.value + 1) % count;
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selIdx.value = (sel.value - 1 + count) % count;
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const pick = matches.value[sel.value];
      if (pick !== undefined) insertMention(pick);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const m = mention.value;
      if (m !== undefined) dismissed.value = `${m.start}:${m.query}`;
      return;
    }
  }
  if (event.key === "Escape" && props.stop !== undefined) {
    const now = Date.now();
    if (doublePressed(lastEsc.value, now)) {
      lastEsc.value = undefined;
      event.preventDefault();
      props.stop();
      return;
    }
    lastEsc.value = now;
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
}
</script>

<template>
  <form class="composer" @submit.prevent="submit" @click.self="textarea?.focus()">
    <textarea
      ref="textarea"
      v-model="text"
      rows="1"
      :placeholder="placeholder"
      :aria-label="placeholder"
      :aria-describedby="`${listId}-hint`"
      :disabled="busy || disabled"
      aria-autocomplete="list"
      :aria-controls="mentionOpen ? listId : undefined"
      :aria-activedescendant="mentionOpen ? `${listId}-${sel}` : undefined"
      @keydown="onKeydown"
      @input="syncCaret"
      @keyup="syncCaret"
      @click="syncCaret"
      @select="syncCaret"
      @blur="syncCaret"
    />
    <div v-if="mentionOpen" :id="listId" class="pop up mention-pop" role="listbox">
      <button
        v-for="(view, i) in matches"
        :id="`${listId}-${i}`"
        :key="view.ticket.id"
        type="button"
        class="pop-row"
        :class="{ sel: i === sel }"
        role="option"
        :aria-selected="i === sel"
        @mousedown.prevent
        @mouseenter="selIdx = i"
        @click="insertMention(view)"
      >
        <StageGlyph :stage="effectiveStage(view)" />
        <span class="mention-id">{{ view.ticket.id }}</span>
        <span class="mention-title ellipsis">{{ view.ticket.title }}</span>
      </button>
    </div>
    <div class="c-actions">
      <slot name="actions" />
      <span class="spacer" />
      <span :id="`${listId}-hint`" class="composer-hint">{{ t("Shift+Enter for a new line") }}</span>
      <slot name="end" />
      <button
        class="send"
        type="submit"
        :disabled="busy || disabled || text.trim() === ''"
        :title="t('Send (Enter)')"
        :aria-label="t('Send')"
      >
        <Icon name="arrowUp" size="sm" />
      </button>
    </div>
  </form>
  <p v-if="error" class="composer-error" role="alert">{{ error }}</p>
</template>
