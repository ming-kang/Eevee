<script setup lang="ts">
import { computed } from "vue";
import type { VisualStage } from "../board.ts";
import { t } from "../i18n.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";

/**
 * The header button that brings the tickets rail back: shown whenever the rail is not on screen
 * (collapsed column or drawer mode). Its icon sits where the rail's own collapse button sits when
 * the rail is open; what waits inside hangs in a small column directly under it.
 */
const props = defineProps<{
  /** The rail is collapsed as a column; drawer widths show the button without it. */
  closed: boolean;
  /** Displayed in the tooltip, e.g. "Ctrl Alt B". */
  shortcut: string;
  /** Open questions waiting for an answer. */
  questions: number;
  /** Tickets whose report awaits review. */
  review: number;
  /** Tickets stopped on a problem. */
  blocked: number;
}>();

defineEmits<{
  open: [];
}>();

const marks = computed(() => {
  const list: { stage: VisualStage; count: number }[] = [];
  if (props.questions > 0) list.push({ stage: "answer", count: props.questions });
  if (props.review > 0) list.push({ stage: "review", count: props.review });
  if (props.blocked > 0) list.push({ stage: "blocked", count: props.blocked });
  return list;
});
</script>

<template>
  <div class="rail-toggle" :class="{ closed }">
    <button
      type="button"
      class="btn ghost sm icon"
      :title="t('Show the tickets panel ({key})', { key: shortcut })"
      :aria-label="t('Show the tickets panel ({key})', { key: shortcut })"
      @click="$emit('open')"
    >
      <Icon name="panel" size="sm" />
    </button>
    <div v-if="marks.length > 0" class="rt-marks" aria-hidden="true">
      <button
        v-for="mark in marks"
        :key="mark.stage"
        type="button"
        class="rt-mark"
        tabindex="-1"
        @click="$emit('open')"
      >
        <StageGlyph :stage="mark.stage" /><span class="rt-n">{{ mark.count }}</span>
      </button>
    </div>
  </div>
</template>
