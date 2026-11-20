<script setup lang="ts">
import { computed } from "vue";
import { vTail } from "../dom.ts";
import HighlightedCode from "./HighlightedCode.vue";

/**
 * The one detail sheet under a step row: the full arguments, the output, then whatever status the
 * row didn't already say. Output is stripped of ANSI colour before it is shown.
 */
const props = defineProps<{
  /** The full label/arguments; rendered as highlighted code when `lang` is set. */
  label?: string;
  lang?: string;
  output?: string;
  /** Status or duration the row didn't already show. */
  meta?: string;
}>();

const ANSI = new RegExp(
  "\\x1b(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1b\\\\)|[@-Z\\\\-_])",
  "g",
);

const output = computed(() => (props.output ?? "").replace(ANSI, "").trim());
</script>

<template>
  <div class="tsheet">
    <HighlightedCode v-if="lang && label" class="tsheet-code" :code="label" :lang="lang" />
    <div v-else-if="label" class="tsheet-label">{{ label }}</div>
    <pre v-if="output" v-tail class="step-out">{{ output }}</pre>
    <div v-if="meta" class="tsheet-meta">{{ meta }}</div>
  </div>
</template>
