<script setup lang="ts">
import { ref } from "vue";
import { t } from "../../lib/i18n.ts";
import type { OutlineEntry } from "../../lib/outline.ts";
import { formatClockTime } from "../../lib/time.ts";
import { menuPanel, menuRow } from "../../ui/menu.ts";

/**
 * The slim rail at the chat's right edge: one tick per thing the reader said, lit at the
 * viewport's line. Hovering or focusing it opens the same entries as a list; picking one jumps
 * the conversation to that message.
 */
defineProps<{
  entries: readonly OutlineEntry[];
  /** Tick position per entry, 0–1 down the conversation. */
  ticks: readonly number[];
  /** Entry at the reading line, −1 above the first. */
  active: number;
}>();

const emit = defineEmits<{ pick: [key: string] }>();

const open = ref(false);

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (!(next instanceof Node) || !(event.currentTarget as HTMLElement).contains(next)) {
    open.value = false;
  }
}

function onEscape(event: KeyboardEvent): void {
  open.value = false;
  (event.target as HTMLElement | null)?.blur();
}

function pick(key: string): void {
  open.value = false;
  emit("pick", key);
}
</script>

<template>
  <nav
    class="pointer-events-auto relative mr-0.5 h-[min(calc(300px*var(--ev-scale)),42vh)] w-7.5 -translate-y-1/2"
    :aria-label="t('Conversation outline')"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @focusin="open = true"
    @focusout="onFocusOut"
    @keydown.esc="onEscape"
  >
    <div class="absolute inset-0">
      <button
    v-for="(entry, i) in entries"
    :key="entry.key"
    type="button"
    class="absolute right-1.5 flex h-3 w-5.5 -translate-y-1/2 items-center justify-end p-0 after:h-0.5 after:rounded-[1px] after:transition-[width,background-color] after:duration-(--ev-fast) after:content-['']"
    :class="i === active ? 'after:w-4 after:bg-fg' : 'after:w-2.5 after:bg-fg-subtle hover:after:w-3.5 hover:after:bg-fg-muted focus-visible:after:w-3.5 focus-visible:after:bg-fg-muted'"
    :style="{ top: `${(ticks[i] ?? 0) * 100}%` }"
    :aria-label="entry.text || t('Message')"
    @click="pick(entry.key)"
   />
    </div>
    <div v-if="open" class="top-1/2 right-[calc(100%+calc(4px*var(--ev-scale)))] max-h-80 w-[min(calc(300px*var(--ev-scale)),calc(100vw-calc(80px*var(--ev-scale))))] -translate-y-1/2 animate-[ev-fade_var(--ev-regular)_var(--ev-ease)] overflow-y-auto" :class="menuPanel({ animate: false })" role="list">
      <button
    v-for="(entry, i) in entries"
    :key="entry.key"
    type="button"
    
    :class="[menuRow('auto'), { sel: i === active }]"
    role="listitem"
    @click="pick(entry.key)"
>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="ellipsis min-w-0">{{ entry.text || t("Message") }}</span>
          <span v-if="entry.reply" class="line-clamp-2 text-xs text-fg-subtle">{{ entry.reply }}</span>
        </span>
        <span v-if="entry.at !== undefined" class="meta">{{ formatClockTime(entry.at) }}</span>
      </button>
    </div>
  </nav>
</template>
