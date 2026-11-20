<script setup lang="ts">
import { computed } from "vue";
import { ICONS, type IconName } from "../icons.ts";

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: "xs" | "sm" | "md" | "lg";
    spin?: boolean;
  }>(),
  { size: "md", spin: false },
);

const spec = computed(() => ICONS[props.name]);
const spinning = computed(() => props.spin || props.name === "spinner");
const sizeClass = computed(() => (props.size === "md" ? "" : props.size));
</script>

<template>
  <!-- A turning icon rotates an HTML wrapper so Chromium composites on the GPU at non-1x DPR. -->
  <span v-if="spinning" class="ico spin" :class="sizeClass" aria-hidden="true">
    <component :is="spec.component" />
  </span>
  <component
    :is="spec.component"
    v-else
    class="ico"
    :class="[sizeClass, { 'flip-x': spec.flipX }]"
    aria-hidden="true"
  />
</template>
