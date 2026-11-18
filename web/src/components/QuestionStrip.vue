<script setup lang="ts">
import Icon from "./Icon.vue";

defineProps<{ count: number }>();
defineEmits<{ expand: [] }>();
</script>

<template>
  <button type="button" class="qstrip" @click="$emit('expand')">
    <span class="dot user" />
    <span>{{ count }} 个问题等你回答</span>
    <span class="spacer" />
    <Icon name="chevU" size="sm" />
  </button>
</template>
