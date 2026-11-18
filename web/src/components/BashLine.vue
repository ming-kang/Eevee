<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { vTail } from "../dom.ts";
import { formatDurationMs, formatElapsedSeconds } from "../time.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";

const props = defineProps<{
  command: string;
  status: "run" | "exit" | "stopped" | "job";
  output: string;
  exitCode?: number;
  ms?: number;
  jobId?: string;
  at?: number;
  runningJobIds?: ReadonlySet<string>;
}>();

defineEmits<{
  "open-job": [jobId: string];
}>();

const mountedAt = Date.now();
const nowMs = ref(mountedAt);
let timer: ReturnType<typeof setInterval> | undefined;

function stopTimer(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

watch(
  () => props.status === "run",
  (running) => {
    stopTimer();
    if (running) {
      nowMs.value = Date.now();
      timer = setInterval(() => {
        nowMs.value = Date.now();
      }, 1000);
    }
  },
  { immediate: true },
);

onUnmounted(stopTimer);

const elapsed = computed(() =>
  formatElapsedSeconds(Math.max(0, (nowMs.value - (props.at ?? mountedAt)) / 1000)),
);

const isJobActive = computed(
  () => Boolean(props.jobId && props.runningJobIds?.has(props.jobId)),
);
</script>

<template>
  <details class="proc" :open="status === 'run'">
    <summary>
      <Icon name="chevR" size="xs" class="chev" />
      <span class="ellipsis" :class="{ shimmer: status === 'run' }">
        运行 <span class="mono">{{ command }}</span>
      </span>
      <span v-if="status === 'run'" class="num">{{ elapsed }}</span>
      <span v-else-if="status === 'stopped'" class="dim">已打断</span>
      <span v-else-if="status === 'job'" class="dim">转入后台</span>
      <span v-else class="num">
        <template v-if="exitCode && exitCode !== 0">exit {{ exitCode }}{{ ms !== undefined ? " · " : "" }}</template>
        <template v-if="ms !== undefined">{{ formatDurationMs(ms) }}</template>
      </span>
    </summary>
    <pre v-if="output" v-tail class="step-out">{{ output }}</pre>
  </details>
  <button
    v-if="status === 'job' && jobId"
    type="button"
    class="note link"
    @click="$emit('open-job', jobId)"
  >
    <StageGlyph stage="jobs" />
    <span>后台作业 <span class="mono">{{ jobId }}</span></span>
    <span class="dim">{{ isJobActive ? "进行中" : "已结束" }}</span>
  </button>
</template>
