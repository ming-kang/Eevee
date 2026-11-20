<script setup lang="ts">
import { useToasts } from "../toasts.ts";
import Icon from "./Icon.vue";

const { toasts } = useToasts();
</script>

<template>
  <TransitionGroup tag="div" name="toast" class="toasts" aria-live="polite">
    <div v-for="item in toasts" :key="item.id" class="toast" :class="item.tone">
      <Icon :name="item.tone === 'error' ? 'alert' : 'check'" size="sm" />
      <span>{{ item.message }}</span>
    </div>
  </TransitionGroup>
</template>
