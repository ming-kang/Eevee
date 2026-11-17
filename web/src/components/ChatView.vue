<script setup lang="ts">
import type { ChatLine } from "@shared/api/contract.ts";
import { computed, nextTick, ref, watch } from "vue";
import { toBlocks } from "../chat.ts";
import { ROLE_LABEL } from "../labels.ts";
import { useSubmit } from "../submit.ts";

const props = withDefaults(
  defineProps<{
    lines: readonly ChatLine[];
    running?: boolean;
    failure?: string | undefined;
    retry?: () => Promise<void>;
    assistant?: string;
    empty?: string;
  }>(),
  { running: false, failure: undefined, retry: undefined, assistant: "Router", empty: "" },
);
const blocks = computed(() => toBlocks(props.lines));
const label = (role: ChatLine["role"]) =>
  role === "assistant" ? props.assistant : ROLE_LABEL[role];
const retrying = useSubmit();
const scroller = ref<HTMLElement>();

watch(
  () => props.lines.at(-1)?.id,
  async () => {
    const el = scroller.value;
    const atBottom = el !== undefined && el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    await nextTick();
    if (atBottom || el?.scrollTop === 0) el?.scrollTo({ top: el.scrollHeight });
  },
);
</script>

<template>
  <div ref="scroller" class="chat">
    <p v-if="blocks.length === 0" class="muted empty">{{ empty }}</p>
    <template v-for="block in blocks" :key="block.key">
      <div v-if="block.kind === 'message'" class="message" :class="block.line.role">
        <div class="who muted">{{ label(block.line.role) }}</div>
        <div class="text">{{ block.line.text }}</div>
      </div>
      <details v-else class="process">
        <summary class="muted">过程 · {{ block.lines.length }} 步</summary>
        <div v-for="line in block.lines" :key="line.id" class="step">
          <span class="muted">{{ label(line.role) }}</span>
          <pre>{{ line.text }}</pre>
        </div>
      </details>
    </template>
    <p v-if="running" class="muted running">{{ assistant }} 正在处理…</p>
    <div v-else-if="failure" class="failure">
      <span>上一轮没有完成：{{ failure }}</span>
      <button
        v-if="retry"
        type="button"
        :disabled="retrying.busy.value"
        @click="retrying.run(retry)"
      >
        重试
      </button>
      <span v-if="retrying.error.value" class="error">{{ retrying.error.value }}</span>
    </div>
  </div>
</template>

<style scoped>
.chat {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.empty {
  margin: auto;
}

.message {
  max-width: 760px;
}

.message.user {
  align-self: flex-end;
  background: var(--ev-bg-raised);
  border-radius: var(--ev-radius);
  padding: 8px 14px;
}

.message.notice {
  border-left: 3px solid var(--ev-accent);
  padding-left: 12px;
}

.who {
  font-size: 12px;
}

.message.user .who {
  display: none;
}

.text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.running {
  font-size: 12px;
}

.failure {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  border-left: 3px solid var(--ev-danger);
  padding: 6px 12px;
  overflow-wrap: anywhere;
}

.process summary {
  cursor: pointer;
  font-size: 12px;
}

.step pre {
  margin: 4px 0 8px;
  padding: 8px 10px;
  background: var(--ev-bg-raised);
  border-radius: 8px;
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
}
</style>
