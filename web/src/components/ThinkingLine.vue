<script setup lang="ts">
import { computed } from "vue";
import { fold } from "../folds.ts";
import { t } from "../i18n.ts";
import type { TranscriptDisplayItem } from "../transcript-map.ts";
import Icon from "./Icon.vue";
import MarkdownText from "./MarkdownText.vue";

const props = withDefaults(
  defineProps<{
    /** The thinking item this line presents. */
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
  <div class="thinking-line" :class="{ open, redacted }">
    <button
      type="button"
      class="thinking-head"
      :disabled="redacted"
      :aria-expanded="redacted ? undefined : open"
      @click="toggle"
    >
      <Icon v-if="!redacted" name="chevR" size="xs" class="chev" />
      <span v-if="redacted" class="thinking-label">{{ t("Thought (hidden)") }}</span>
      <span v-else-if="streaming" class="thinking-label shimmer">{{ t("Thinking…") }}</span>
      <span v-else class="thinking-label">{{ t("Thought") }}</span>
      <span v-if="!open && !redacted && preview" class="thinking-preview ellipsis">
        {{ preview }}
      </span>
    </button>
    <div v-if="open && !redacted" class="thinking-body">
      <MarkdownText :source="item.text" />
    </div>
  </div>
</template>
