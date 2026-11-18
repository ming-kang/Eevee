<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "../i18n.ts";
import { formatClockTime } from "../time.ts";

const props = defineProps<{
  summary: string;
  at?: number;
}>();

const open = ref(false);
const timeText = computed(() => (props.at === undefined ? "" : formatClockTime(props.at)));
</script>

<template>
  <div class="reset">
    <div class="reset-line">
      <button type="button" :aria-expanded="open" @click="open = !open">
        {{ t("Handoff") }}{{ timeText ? ` · ${timeText}` : "" }}
      </button>
    </div>
    <div v-if="open" class="handoff">{{ summary }}</div>
  </div>
</template>
