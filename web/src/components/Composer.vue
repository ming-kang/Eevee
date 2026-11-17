<script setup lang="ts">
import { ref } from "vue";
import { useSubmit } from "../submit.ts";

const props = withDefaults(
  defineProps<{ send: (text: string) => Promise<void>; placeholder?: string }>(),
  { placeholder: "告诉 Router 你想做什么…" },
);
const text = ref("");
const { busy, error, run } = useSubmit();

async function submit(): Promise<void> {
  const value = text.value.trim();
  if (value === "") return;
  if (await run(() => props.send(value))) text.value = "";
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}
</script>

<template>
  <form class="composer" @submit.prevent="submit">
    <textarea
      v-model="text"
      rows="3"
      :placeholder="placeholder"
      :disabled="busy"
      @keydown="onKeydown"
    />
    <div class="actions">
      <slot />
      <span class="spacer" />
      <span v-if="error" class="error">{{ error }}</span>
      <button class="primary" type="submit" :disabled="busy || text.trim() === ''">发送</button>
    </div>
  </form>
</template>

<style scoped>
.composer {
  border: 1px solid var(--ev-border);
  border-radius: var(--ev-radius);
  padding: 10px 12px;
  background: var(--ev-bg);
}

textarea {
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
}

.spacer {
  flex: 1;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
