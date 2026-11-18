<script setup lang="ts">
/** Stands in for content on its way. A wait shorter than a blink shows nothing (`.skeleton`). */
withDefaults(defineProps<{ lines?: number }>(), { lines: 3 });
</script>

<template>
  <div class="skeleton" role="status" aria-label="正在加载">
    <span v-for="n in lines" :key="n" class="sk" />
  </div>
</template>
