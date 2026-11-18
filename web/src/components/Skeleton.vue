<script setup lang="ts">
import { t } from "../i18n.ts";
/** Stands in for content on its way. A wait shorter than a blink shows nothing (`.skeleton`). */
withDefaults(defineProps<{ lines?: number }>(), { lines: 3 });
</script>

<template>
  <div class="skeleton" role="status" :aria-label="t('Loading')">
    <span v-for="n in lines" :key="n" class="sk" />
  </div>
</template>
