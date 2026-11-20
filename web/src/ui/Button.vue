<script setup lang="ts">
import { computed, useTemplateRef } from "vue";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "ghost-danger";

const props = withDefaults(
  defineProps<{
    variant?: ButtonVariant;
    size?: "sm" | "md";
    icon?: boolean;
    type?: "button" | "submit" | "reset";
    href?: string;
  }>(),
  { variant: "default", size: "md", icon: false, type: "button" },
);

const VARIANTS: Record<ButtonVariant, string> = {
  default: "border-border-strong bg-surface text-fg shadow-xs hover:bg-surface-2",
  primary: "border-transparent bg-accent text-accent-fg shadow-xs hover:bg-accent-hover",
  danger:
    "border-[color-mix(in_oklab,var(--danger)_32%,var(--border-strong))] bg-surface text-danger hover:bg-danger-soft",
  ghost: "border-transparent bg-transparent text-fg-muted hover:bg-hover hover:text-fg active:bg-selected",
  "ghost-danger": "border-transparent bg-transparent text-danger hover:bg-danger-soft",
};

const SIZES = {
  md: { box: "h-8 gap-1.5 rounded-md px-3", icon: "w-8 px-0" },
  sm: { box: "h-7 gap-1 rounded-sm px-2.5", icon: "w-7 px-0" },
};

const classes = computed(() => [
  "inline-flex flex-none select-none items-center justify-center whitespace-nowrap border text-sm font-medium transition-[background-color,border-color,color,box-shadow,opacity] disabled:opacity-45",
  VARIANTS[props.variant],
  SIZES[props.size].box,
  props.icon && SIZES[props.size].icon,
]);
const root = useTemplateRef<HTMLElement>("root");
defineExpose({ focus: () => root.value?.focus() });
</script>

<template>
  <a v-if="href !== undefined" ref="root" :href="href" :class="classes"><slot /></a>
  <button v-else ref="root" :type="type" :class="classes"><slot /></button>
</template>
