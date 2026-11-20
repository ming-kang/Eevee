<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "../../lib/i18n.ts";
import { formatClockTime } from "../../lib/time.ts";
import Icon from "../../ui/Icon.vue";

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
  <div class="mt-0.5 flex min-h-5 items-center gap-2.5 px-1 text-xs text-fg-subtle opacity-0 transition-opacity focus-within:opacity-100 in-[.turn:focus-within]:opacity-100 in-[.turn:hover]:opacity-100 in-[.u-wrap:focus-within]:opacity-100 in-[.u-wrap:hover]:opacity-100" :class="{ '[@media(hover:none)]:opacity-100': latest }">
    <button type="button" class="-ml-1.25 inline-flex items-center gap-1 rounded-xs px-1.25 py-px text-fg-subtle transition-colors hover:bg-hover hover:text-fg focus-visible:shadow-(--ring-inset)" @click="copy">
      <Icon :name="copied ? 'check' : 'copy'" size="xs" />
      <span>{{ copied ? t("Copied") : t("Copy") }}</span>
    </button>
    <span v-if="timeText" class="tabular-nums">{{ timeText }}</span>
  </div>
</template>
