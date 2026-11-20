<script setup lang="ts">
import { ref, watch } from "vue";
import { highlightToHtml, resolveLang } from "../../lib/highlight.ts";

/**
 * A code block that renders its plain text first and swaps in Shiki's markup once the grammar is
 * ready, so nothing moves while it loads. Unknown languages and failures stay plain.
 */
const props = defineProps<{
  code: string;
  lang?: string;
  /** Still streaming: keep the plain text until the message settles. */
  streaming?: boolean;
}>();

const html = ref<string>();
let seq = 0;

watch(
  () => [props.code, props.lang, props.streaming] as const,
  async ([code, info, streaming]) => {
    const mine = ++seq;
    const lang = streaming ? undefined : resolveLang(info);
    if (lang === undefined) {
      html.value = undefined;
      return;
    }
    const out = await highlightToHtml(code, lang);
    if (mine === seq) html.value = out;
  },
  { immediate: true },
);
</script>

<template>
  <!-- The plain pre and Shiki's pre take the same styles, so the swap doesn't shift the page. -->
  <!-- eslint-disable-next-line vue/no-v-html -- Shiki output is escaped markup from a local grammar -->
  <div v-if="html !== undefined" class="hcode" v-html="html" />
  <pre v-else class="hcode-plain"><code>{{ code }}</code></pre>
</template>
