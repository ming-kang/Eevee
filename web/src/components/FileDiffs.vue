<script setup lang="ts">
import type { GitFileDiff } from "../memory.ts";
import Icon from "./Icon.vue";

defineProps<{
  diffs: readonly GitFileDiff[];
  emptyText?: string;
}>();
</script>

<template>
  <p v-if="diffs.length === 0" class="hint" style="margin: 0">
    {{ emptyText ?? "没有文本 diff 内容。" }}
  </p>
  <template v-else>
    <div v-for="file in diffs" :key="file.file" class="card file-diff">
      <div class="card-h">
        <Icon name="file" size="sm" />
        <span class="path">{{ file.file }}</span>
        <span v-if="file.newFile" class="chip" style="height: 18px">新文件</span>
        <span v-else-if="file.deletedFile" class="chip" style="height: 18px">已删除</span>
        <span class="spacer" />
        <span v-if="!file.binary" class="stat">
          <span class="plus">+{{ file.added }}</span>
          {{ " " }}
          <span class="minus">−{{ file.removed }}</span>
        </span>
      </div>
      <div v-if="file.binary" class="hint" style="padding: 10px 12px">二进制文件，无法显示逐行 diff。</div>
      <div v-else class="diff">
        <template v-for="(hunk, hi) in file.hunks" :key="hi">
          <div class="hunk">{{ hunk.head }}</div>
          <div v-for="(line, li) in hunk.lines" :key="li" class="ln" :class="line.k">
            <span>{{ line.o ?? "" }}</span>
            <span>{{ line.n ?? "" }}</span>
            <span class="mk">{{ line.k === "add" ? "+" : line.k === "del" ? "−" : "" }}</span>
            <span>{{ line.s }}</span>
          </div>
        </template>
      </div>
    </div>
  </template>
</template>
