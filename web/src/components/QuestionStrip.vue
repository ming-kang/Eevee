<script setup lang="ts">
defineProps<{ count: number }>();
defineEmits<{ expand: [] }>();
</script>

<template>
  <button type="button" class="qstrip" @click="$emit('expand')">
    <span class="dot user" />
    <span>{{ count }} 个问题等你回答</span>
    <span class="spacer" />
    <span class="dim">展开</span>
  </button>
</template>
