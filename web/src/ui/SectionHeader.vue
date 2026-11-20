<script setup lang="ts">
/** A page section's title row: an optional leading control, the title, then its actions. */
defineProps<{ title: string; mono?: boolean }>();
</script>

<template>
  <header class="mb-2 flex min-h-8 items-center gap-3">
    <slot name="leading" />
    <h2
      class="min-w-0 flex-1 truncate font-medium"
      :class="mono ? 'font-mono text-lg' : 'text-xl tracking-[-0.02em]'"
    >
      {{ title }}
    </h2>
    <slot />
  </header>
</template>
