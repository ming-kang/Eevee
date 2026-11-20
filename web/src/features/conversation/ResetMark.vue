<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "../../lib/i18n.ts";
import { formatClockTime } from "../../lib/time.ts";

const props = defineProps<{
  summary: string;
  at?: number;
}>();

const open = ref(false);
const timeText = computed(() => (props.at === undefined ? "" : formatClockTime(props.at)));
</script>

<template>
  <div class="my-2.5">
    <div class="flex items-center gap-3 text-xs text-fg-subtle before:h-px before:flex-1 before:bg-separator before:content-[''] after:h-px after:flex-1 after:bg-separator after:content-['']">
      <button type="button" class="rounded-xs px-1.5 py-0.5 text-inherit transition-colors hover:text-fg" :aria-expanded="open" @click="open = !open">
        {{ t("Handoff") }}{{ timeText ? ` · ${timeText}` : "" }}
      </button>
    </div>
    <div v-if="open" class="mt-2.5 rounded-md bg-sidebar px-3.5 py-3 text-sm leading-[1.65] whitespace-pre-wrap text-fg-muted animate-[ev-fade_var(--ev-regular)_var(--ev-ease)]">{{ summary }}</div>
  </div>
</template>
