<script setup lang="ts">
import { ref } from "vue";
import type { VisualStage } from "../../lib/board.ts";
import { t } from "../../lib/i18n.ts";
import Icon from "../../ui/Icon.vue";
import StageGlyph from "../project/StageGlyph.vue";
import Button from "../../ui/Button.vue";

export type RailMark = { stage: VisualStage; count: number };

/**
 * Stationary top-right trigger for the tickets/jobs rail, mirroring the left sidebar trigger:
 * one persistent DOM button that stays at the exact same viewport coordinate whether the rail is
 * expanded, collapsed offcanvas, or open as a drawer.
 */
defineProps<{
  open: boolean;
  shortcut: string;
  marks: readonly RailMark[];
}>();

defineEmits<{
  toggle: [];
  "open-tickets": [];
}>();

const btn = ref<{ focus(): void }>();

defineExpose({
  focus: () => btn.value?.focus(),
});
</script>

<template>
  <div class="rail-trigger">
    <div v-if="!open && marks.length > 0" class="rt-pills">
      <button
        v-for="mark in marks"
        :key="mark.stage"
        type="button"
        class="rt-pill"
        :class="`s-${mark.stage}`"
        :title="t('Show the tickets panel ({key})', { key: shortcut })"
        @click="$emit('open-tickets')"
      >
        <StageGlyph :stage="mark.stage" /><span class="rt-n">{{ mark.count }}</span>
      </button>
    </div>
    <Button ref="btn" variant="ghost" size="sm" icon class="rail-trigger-btn" :aria-expanded="open" :title="
        open
          ? t('Collapse the tickets panel ({key})', { key: shortcut })
          : t('Show the tickets panel ({key})', { key: shortcut })
      " :aria-label="
        open
          ? t('Collapse the tickets panel')
          : t('Show the tickets panel ({key})', { key: shortcut })
      " @click="$emit('toggle')">
      <Icon :name="open ? 'panelClose' : 'panel'" size="sm" />
    </Button>
  </div>
</template>
