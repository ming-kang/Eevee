<script setup lang="ts">
import { t } from "../lib/i18n.ts";
/** Stands in for content on its way. A wait shorter than a blink shows nothing (`.skeleton`). */
withDefaults(defineProps<{ lines?: number }>(), { lines: 3 });
</script>

<template>
  <div class="grid animate-[ev-fade_var(--ev-regular)_var(--ev-ease)_240ms_both] gap-3 py-1" role="status" :aria-label="t('Loading')">
    <span v-for="n in lines" :key="n" class="h-[calc(var(--ev-ui)*20/14)] animate-[ev-breathe_1.8s_steps(10,end)_infinite] rounded-(--ev-r-mini) bg-(--ev-skeleton) nth-[3n]:w-[58%] nth-[3n+2]:w-[82%]" />
  </div>
</template>
