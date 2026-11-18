<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { t } from "../i18n.ts";
import { useSubmit } from "../submit.ts";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    send: (text: string) => Promise<void>;
    placeholder?: string;
    draftKey?: string;
    disabled?: boolean;
  }>(),
  { placeholder: t("告诉 Router 要做什么"), draftKey: "", disabled: false },
);

const draftStore = new Map<string, string>();
const text = ref(props.draftKey ? (draftStore.get(props.draftKey) ?? "") : "");
const textarea = ref<HTMLTextAreaElement>();
const { busy, error, run } = useSubmit();

function autosize(): void {
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(220, el.scrollHeight)}px`;
}

watch(
  () => props.draftKey,
  async (nextKey) => {
    text.value = nextKey ? (draftStore.get(nextKey) ?? "") : "";
    await nextTick();
    autosize();
  },
);

watch(text, (val) => {
  if (props.draftKey) draftStore.set(props.draftKey, val);
  void nextTick(autosize);
});

onMounted(autosize);

async function submit(): Promise<void> {
  const value = text.value.trim();
  if (value === "" || props.disabled) return;
  if (await run(() => props.send(value))) {
    text.value = "";
    if (props.draftKey) draftStore.delete(props.draftKey);
    await nextTick();
    autosize();
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}
</script>

<template>
  <form class="composer" @submit.prevent="submit" @click.self="textarea?.focus()">
    <textarea
      ref="textarea"
      v-model="text"
      rows="1"
      :placeholder="placeholder"
      :aria-label="placeholder"
      :disabled="busy || disabled"
      @keydown="onKeydown"
    />
    <div class="c-actions">
      <slot name="actions" />
      <span class="spacer" />
      <slot name="end" />
      <button
        class="send"
        type="submit"
        :disabled="busy || disabled || text.trim() === ''"
        :title="t('发送（Enter）')"
        :aria-label="t('发送')"
      >
        <Icon name="arrowUp" size="sm" />
      </button>
    </div>
  </form>
  <p v-if="error" class="composer-error" role="alert">{{ error }}</p>
</template>
