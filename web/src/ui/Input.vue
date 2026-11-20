<script setup lang="ts">
import { computed, useTemplateRef } from "vue";
import { fieldClass } from "./field.ts";

const props = withDefaults(defineProps<{ mono?: boolean; size?: "sm" | "md"; inline?: boolean }>(), {
  mono: false,
  inline: false,
  size: "md",
});
const model = defineModel<string | number | undefined>();
const classes = computed(() => fieldClass({ mono: props.mono, size: props.size, inline: props.inline }));
const root = useTemplateRef<HTMLInputElement>("root");
defineExpose({ focus: () => root.value?.focus() });
</script>

<template>
  <input ref="root" v-model="model" :class="classes" />
</template>
