<script setup lang="ts">
import { computed, ref } from "vue";
import { announceSashDragEnd } from "../composables/dom.ts";
import { SASH_STEP } from "../lib/layout.ts";

const props = defineProps<{
  /** Which edge of the main column the sash sits on; it decides which way a drag widens. */
  side: "left" | "right";
  label: string;
  min: number;
  max: number;
  now: number;
}>();

const emit = defineEmits<{
  /** A pointer drag proposed a new width (unclamped; the parent fits it). */
  resize: [width: number];
  /** The pointer drag finished or was cancelled; the last resize already fired. */
  dragend: [];
  /** Arrow keys proposed a new width (unclamped). */
  step: [width: number];
  /** Enter or double-click asked for the default width. */
  reset: [];
}>();

const sign = computed(() => (props.side === "left" ? 1 : -1));

let startX = 0;
let lastX = 0;
let startW = 0;
let raf = 0;
const dragging = ref(false);

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  startX = event.clientX;
  lastX = event.clientX;
  startW = props.now;
  dragging.value = true;
  document.documentElement.classList.add("ev-sash-drag");
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return;
  lastX = event.clientX;
  // Pointer events can arrive several times a frame; the column only repaints once anyway.
  if (raf !== 0) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    emit("resize", startW + sign.value * (lastX - startX));
  });
}

function endDrag(event: PointerEvent): void {
  if (!dragging.value) return;
  dragging.value = false;
  document.documentElement.classList.remove("ev-sash-drag");
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  if (raf !== 0) {
    // Land on the finger's last spot instead of the last frame's.
    cancelAnimationFrame(raf);
    raf = 0;
    emit("resize", startW + sign.value * (lastX - startX));
  }
  emit("dragend");
  // After the parent's commit has flushed, observers that skipped measuring re-measure.
  requestAnimationFrame(announceSashDragEnd);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -SASH_STEP : SASH_STEP;
    emit("step", props.now + sign.value * step);
  } else if (event.key === "Enter") {
    event.preventDefault();
    emit("reset");
  }
}
</script>

<template>
  <div
    class="sash"
    :class="[`s-${side}`, { active: dragging }]"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="Math.round(now)"
    tabindex="0"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @keydown="onKeydown"
    @dblclick="emit('reset')"
  />
</template>
