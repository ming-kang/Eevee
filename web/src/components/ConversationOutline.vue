<script setup lang="ts">
import { ref } from "vue";
import { t } from "../i18n.ts";
import type { OutlineEntry } from "../outline.ts";
import { formatClockTime } from "../time.ts";

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
    class="outline"
    :aria-label="t('Conversation outline')"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @focusin="open = true"
    @focusout="onFocusOut"
    @keydown.esc="onEscape"
  >
    <div class="outline-ticks">
      <button
        v-for="(entry, i) in entries"
        :key="entry.key"
        type="button"
        class="tick"
        :class="{ on: i === active }"
        :style="{ top: `${(ticks[i] ?? 0) * 100}%` }"
        :aria-label="entry.text || t('Message')"
        @click="pick(entry.key)"
      />
    </div>
    <div v-if="open" class="pop outline-list" role="list">
      <button
        v-for="(entry, i) in entries"
        :key="entry.key"
        type="button"
        class="pop-row"
        :class="{ sel: i === active }"
        role="listitem"
        @click="pick(entry.key)"
      >
        <span class="o-col">
          <span class="o-text ellipsis">{{ entry.text || t("Message") }}</span>
          <span v-if="entry.reply" class="o-reply">{{ entry.reply }}</span>
        </span>
        <span v-if="entry.at !== undefined" class="meta">{{ formatClockTime(entry.at) }}</span>
      </button>
    </div>
  </nav>
</template>
