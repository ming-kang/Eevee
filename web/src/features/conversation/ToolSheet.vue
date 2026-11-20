<script setup lang="ts">
import { computed } from "vue";
import { vTail } from "../../composables/dom.ts";
import HighlightedCode from "../markdown/HighlightedCode.vue";
import { STEP_OUT } from "./steps.ts";

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
  <div class="tsheet mt-1 mb-2 flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 shadow-(--ev-shadow-card) animate-[ev-fade_var(--ev-regular)_var(--ev-ease)] [&_.step-out]:m-0">
    <HighlightedCode v-if="lang && label" class="tsheet-code" :code="label" :lang="lang" />
    <div v-else-if="label" class="m-0 overflow-x-auto p-0 font-mono text-xs leading-[1.6] break-words whitespace-pre-wrap text-fg">{{ label }}</div>
    <pre v-if="output" v-tail :class="STEP_OUT">{{ output }}</pre>
    <div v-if="meta" class="text-xs text-fg-subtle">{{ meta }}</div>
  </div>
</template>
