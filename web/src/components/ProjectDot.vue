<script setup lang="ts">
import { computed } from "vue";
import { projectHue } from "../projects.ts";

const props = defineProps<{ id: string }>();

/** The project's identity hue; `projectHue` keeps it stable and spreads neighbouring ids. */
const hue = computed(() => projectHue(props.id));
</script>

<template>
  <span class="p-dot" :style="{ '--hue': String(hue) }" aria-hidden="true" />
</template>
