<script setup lang="ts">
/**
 * A 3×3 dot grid that pulses in a diagonal wave: something is working. Fits the same end slot a
 * StageGlyph takes; under reduced motion it is a quiet static grid. Purely decorative — the row it
 * sits in names the state.
 */
const DOTS = Array.from({ length: 9 }, (_, i) => (((i % 3) + Math.floor(i / 3)) * 0.14).toFixed(2));
</script>

<template>
  <span class="wgrid" aria-hidden="true">
    <i v-for="(delay, i) in DOTS" :key="i" :style="{ animationDelay: `${delay}s` }" />
  </span>
</template>
