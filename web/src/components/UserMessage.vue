<script setup lang="ts">
import { computed } from "vue";
import { formatClockTime } from "../time.ts";

const props = defineProps<{
  text: string;
  at?: number;
  via?: "direct";
}>();

const timeText = computed(() => (props.at === undefined ? "" : formatClockTime(props.at)));
</script>

<template>
  <div class="u-wrap">
    <div class="msg-user">
      <div v-if="via === 'direct'" class="via">直接介入</div>
      {{ text }}
    </div>
    <span v-if="timeText" class="msg-time">{{ timeText }}</span>
  </div>
</template>
