<script setup lang="ts">
import Icon from "./Icon.vue";

defineProps<{ id?: string }>();
</script>

<template>
  <Icon name="folder" size="xs" class="p-folder" />
</template>
