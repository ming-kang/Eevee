<script setup lang="ts">
import { ref } from "vue";
import { t } from "../i18n.ts";
import type { Block } from "../markdown.ts";
import Icon from "./Icon.vue";
import MarkdownInlines from "./MarkdownInlines.vue";

defineProps<{ blocks: readonly Block[] }>();

const copied = ref<number>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy(index: number, code: string): Promise<void> {
  await navigator.clipboard?.writeText(code).catch(() => undefined);
  copied.value = index;
  clearTimeout(timer);
  timer = setTimeout(() => (copied.value = undefined), 1200);
}
</script>

<template>
  <template v-for="(block, index) in blocks" :key="index">
    <p v-if="block.type === 'paragraph'"><MarkdownInlines :items="block.children" /></p>
    <component :is="`h${block.level}`" v-else-if="block.type === 'heading'">
      <MarkdownInlines :items="block.children" />
    </component>
    <component
      :is="block.ordered ? 'ol' : 'ul'"
      v-else-if="block.type === 'list'"
      :start="block.start"
    >
      <li
        v-for="(item, itemIndex) in block.items"
        :key="itemIndex"
        :class="{ task: item.checked !== undefined }"
      >
        <span v-if="item.checked !== undefined" class="check" :class="{ on: item.checked }">
          <Icon v-if="item.checked" name="check" size="xs" />
        </span>
        <MarkdownBlocks :blocks="item.children" />
      </li>
    </component>
    <div v-else-if="block.type === 'code'" class="code">
      <pre><code>{{ block.code }}</code></pre>
      <button
        type="button"
        class="btn ghost sm icon copy"
        :aria-label="t('Copy')"
        @click="copy(index, block.code)"
      >
        <Icon :name="copied === index ? 'check' : 'copy'" size="xs" />
      </button>
    </div>
    <blockquote v-else-if="block.type === 'quote'"><MarkdownBlocks :blocks="block.children" /></blockquote>
    <div v-else-if="block.type === 'table'" class="table-scroll">
      <table>
        <thead>
          <tr>
            <th v-for="(cell, cellIndex) in block.head" :key="cellIndex" :class="cell.align">
              <MarkdownInlines :items="cell.children" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
            <td v-for="(cell, cellIndex) in row" :key="cellIndex" :class="cell.align">
              <MarkdownInlines :items="cell.children" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <hr v-else />
  </template>
</template>
