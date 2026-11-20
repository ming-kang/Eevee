<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "../i18n.ts";
import { formatClockTime } from "../time.ts";
import Icon from "./Icon.vue";

/**
 * The quiet row under a message: copy the raw text, and when it arrived. It appears while the
 * pointer is over the message; on touch it stays out only for the newest turn.
 */
const props = defineProps<{
  text: string;
  at?: number;
  latest?: boolean;
}>();

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy(): Promise<void> {
  await navigator.clipboard?.writeText(props.text).catch(() => undefined);
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => (copied.value = false), 1200);
}

const timeText = computed(() => (props.at === undefined ? "" : formatClockTime(props.at)));
</script>

<template>
  <div class="msg-actions" :class="{ latest }">
    <button type="button" class="msg-act" @click="copy">
      <Icon :name="copied ? 'check' : 'copy'" size="xs" />
      <span>{{ copied ? t("Copied") : t("Copy") }}</span>
    </button>
    <span v-if="timeText" class="msg-when">{{ timeText }}</span>
  </div>
</template>
