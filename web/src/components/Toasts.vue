<script setup lang="ts">
import { useToasts } from "../toasts.ts";
import Icon from "./Icon.vue";

const { toasts } = useToasts();
</script>

<template>
  <div class="toasts" aria-live="polite">
    <div v-for="item in toasts" :key="item.id" class="toast">
      <Icon :name="item.tone === 'error' ? 'alert' : 'check'" size="sm" />
      <span>{{ item.message }}</span>
    </div>
  </div>
</template>
