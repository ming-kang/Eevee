<script setup lang="ts">
import { computed } from "vue";
import { formatClockTime } from "../time.ts";

const props = defineProps<{
  text: string;
  at?: number;
  pending?: boolean;
}>();

const timeText = computed(() => (props.at === undefined ? "" : formatClockTime(props.at)));
</script>

<template>
  <div class="u-wrap" :class="{ pending }">
    <div v-if="pending || timeText" class="msg-meta">{{ pending ? "待送达" : timeText }}</div>
    <div class="msg-user">{{ text }}</div>
  </div>
</template>
