<script setup lang="ts">
import { computed } from "vue";
import { fold } from "../../composables/folds.ts";
import { t } from "../../lib/i18n.ts";
import type { TranscriptDisplayItem } from "../../lib/transcript-map.ts";
import Icon from "../../ui/Icon.vue";
import MarkdownText from "../markdown/MarkdownText.vue";

const props = withDefaults(
  defineProps<{
    item: Extract<TranscriptDisplayItem, { kind: "thinking" }>;
    /** The fold-memory id; persisted choices ride on it. */
    foldId?: string;
  }>(),
  { foldId: "" },
);

const open = fold(() => props.foldId, false);
const streaming = computed(() => props.item.streaming === true);
const redacted = computed(() => props.item.redacted === true);
const preview = computed(() => {
  if (redacted.value) return "";
  const paragraph = props.item.text.replace(/\r/g, "").split("\n", 1)[0] ?? "";
  return paragraph.replace(/\s+/g, " ").trim();
});

function toggle() {
  if (!redacted.value) open.value = !open.value;
}
</script>

<template>
  <div class="thinking-line text-sm leading-[1.385] text-fg-subtle">
    <button
      type="button"
      class="flex min-h-6 w-fit max-w-full items-center gap-1.5 rounded-sm py-0 text-left transition-colors focus-visible:shadow-(--ring-inset) enabled:hover:text-fg-muted [&_.chev]:size-4 [&_.chev]:text-fg-subtle [&_.chev]:transition-transform"
      :class="open ? 'text-fg [&_.chev]:rotate-90' : 'text-inherit'"
      :disabled="redacted"
      :aria-expanded="redacted ? undefined : open"
      @click="toggle"
    >
      <Icon v-if="!redacted" name="chevR" size="xs" class="chev" />
      <span v-if="redacted" class="flex-none">{{ t("Thought (hidden)") }}</span>
      <span v-else-if="streaming" class="flex-none shimmer">{{ t("Thinking…") }}</span>
      <span v-else class="flex-none">{{ t("Thought") }}</span>
      <span v-if="!open && !redacted && preview" class="ellipsis min-w-0 text-xs text-fg-subtle">
        {{ preview }}
      </span>
    </button>
    <div v-if="open && !redacted" class="mt-0.5 mb-1.5 ml-3.25 pl-3 text-xs text-fg-muted shadow-[inset_1px_0_0_var(--ev-separator)] animate-[ev-fade_var(--ev-regular)_var(--ev-ease)]">
      <MarkdownText :source="item.text" />
    </div>
  </div>
</template>
