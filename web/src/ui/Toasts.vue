<script setup lang="ts">
import { useToasts } from "../composables/toasts.ts";
import Icon from "./Icon.vue";

const { toasts } = useToasts();
</script>

<template>
  <TransitionGroup
    tag="div"
    class="pointer-events-none absolute top-4 left-1/2 z-100 flex -translate-x-1/2 flex-col items-center gap-2"
    leave-active-class="transition-[opacity,translate] duration-(--ev-regular) ease-(--ev-ease)"
    leave-to-class="-translate-y-1 opacity-0"
    move-class="transition-transform duration-(--ev-regular) ease-(--ev-ease)"
    aria-live="polite"
  >
    <div v-for="item in toasts" :key="item.id" class="flex max-w-[min(calc(480px*var(--ev-scale)),calc(100vw_-_calc(32px*var(--ev-scale))))] animate-[ev-drop_var(--ev-regular)_var(--ev-ease)] items-center gap-2 rounded-md border border-border bg-(--ev-glass-bg) py-2.25 pr-3.5 pl-3 text-sm font-medium tracking-(--ev-tracking) shadow-(--ev-shadow-float) backdrop-blur-(--ev-glass-blur) backdrop-saturate-(--ev-glass-sat)" :class="item.tone === 'error' ? '[&_.ico]:text-danger' : '[&_.ico]:text-success'">
      <Icon :name="item.tone === 'error' ? 'alert' : 'check'" size="sm" />
      <span>{{ item.message }}</span>
    </div>
  </TransitionGroup>
</template>
