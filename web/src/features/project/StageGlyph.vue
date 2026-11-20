<script setup lang="ts">
import {
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiPlayCircleLine,
  RiQuestionLine,
  RiRecordCircleLine,
  RiTimeLine,
} from "@remixicon/vue";
import { computed, type Component } from "vue";
import type { VisualStage } from "../board.ts";

export type { VisualStage };

const props = defineProps<{ stage: VisualStage }>();

/** Uniform 16px circular linear family: active states carry semantic ink, settled states stay muted. */
const STAGE_ICONS: Record<VisualStage, Component> = {
  answer: RiQuestionLine,
  review: RiCheckboxCircleLine,
  blocked: RiErrorWarningLine,
  queued: RiTimeLine,
  working: RiLoader4Line,
  jobs: RiPlayCircleLine,
  waiting: RiTimeLine,
  idle: RiCheckboxBlankCircleLine,
  done: RiCheckboxCircleLine,
  cancelled: RiCloseCircleLine,
  progress: RiRecordCircleLine,
};

const glyph = computed(() => STAGE_ICONS[props.stage]);
</script>

<template>
  <span class="glyph" :class="`g-${stage}`" aria-hidden="true">
    <component :is="glyph" />
  </span>
</template>
