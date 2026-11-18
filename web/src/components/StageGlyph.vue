<script setup lang="ts">
import type { VisualStage } from "../board.ts";

export type { VisualStage };

defineProps<{ stage: VisualStage }>();
</script>

<template>
  <!-- The box, not the <svg>, carries the size and the working turn: see Icon.vue. -->
  <span class="glyph" :class="`g-${stage}`" aria-hidden="true">
    <svg viewBox="0 0 16 16">
      <template v-if="stage === 'answer'">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="M6.2 6.3a1.85 1.85 0 1 1 2.7 1.65c-.55.27-.9.7-.9 1.3v.25"
          fill="none"
          stroke="var(--ev-glyph-cut, var(--ev-page))"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle cx="8" cy="11.7" r=".9" fill="var(--ev-glyph-cut, var(--ev-page))" />
      </template>
      <template v-else-if="stage === 'review'">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path
          d="m5.3 8.2 1.9 1.9 3.5-3.8"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </template>
      <template v-else-if="stage === 'blocked'">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="M5 8h6"
          fill="none"
          stroke="var(--ev-glyph-cut, var(--ev-page))"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </template>
      <template v-else-if="stage === 'queued'">
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-dasharray="2.4 2.2"
        />
      </template>
      <template v-else-if="stage === 'working'">
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          opacity="0.25"
        />
        <path
          d="M8 1.75A6.25 6.25 0 0 1 8 14.25"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </template>
      <template v-else-if="stage === 'jobs'">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M8 8V4.4A3.6 3.6 0 1 1 4.8 9.8Z" fill="currentColor" />
      </template>
      <template v-else-if="stage === 'waiting'">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M8 4.9V8l2.1 1.3"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </template>
      <template v-else-if="stage === 'idle'">
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          opacity="0.8"
        />
      </template>
      <template v-else-if="stage === 'done'">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="m5.2 8.2 1.9 1.9 3.6-3.8"
          fill="none"
          stroke="var(--ev-glyph-cut, var(--ev-page))"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </template>
      <template v-else-if="stage === 'cancelled'">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M6 6l4 4M10 6l-4 4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </template>
      <template v-else-if="stage === 'progress'">
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          opacity="0.8"
        />
        <circle cx="8" cy="8" r="2.2" fill="currentColor" />
      </template>
    </svg>
  </span>
</template>
