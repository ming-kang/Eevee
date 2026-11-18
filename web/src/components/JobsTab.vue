<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { JobLogView } from "@shared/api/contract.ts";
import type { JobId, JobStatus } from "@shared/contracts/index.ts";
import { computed, onUnmounted, ref, watch } from "vue";
import type { RunningJobItem } from "../board.ts";
import { vTail } from "../dom.ts";
import { useSubmit } from "../submit.ts";
import { formatElapsedSeconds } from "../time.ts";
import { showToast } from "../toasts.ts";
import Skeleton from "./Skeleton.vue";
import StageGlyph from "./StageGlyph.vue";

const props = defineProps<{
  client: Client;
  projectId: string | undefined;
  jobs: readonly RunningJobItem[];
  openJobId?: string;
}>();

const emit = defineEmits<{
  "update:openJobId": [jobId: string | undefined];
  "open-ticket": [ticketId: string];
}>();

const nowMs = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
let logPollTimer: ReturnType<typeof setInterval> | undefined;
let logSeq = 0;

const logView = ref<JobLogView>();
const logLoading = ref(false);
const logError = ref<string>();
const confirmKillId = ref<string>();
const killing = useSubmit();

function stopTimer(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

function stopLogPoll(): void {
  if (logPollTimer !== undefined) {
    clearInterval(logPollTimer);
    logPollTimer = undefined;
  }
}

watch(
  () => props.jobs.length > 0,
  (active) => {
    stopTimer();
    if (active) {
      nowMs.value = Date.now();
      timer = setInterval(() => {
        nowMs.value = Date.now();
      }, 1000);
    }
  },
  { immediate: true },
);

async function fetchLog(jobId: string, pid: string, silent = false): Promise<void> {
  const token = ++logSeq;
  if (!silent) {
    logLoading.value = true;
    logError.value = undefined;
  }
  try {
    const view = await props.client.call("GET /api/projects/:project/jobs/:job/log", {
      project: pid,
      job: jobId,
    });
    if (token !== logSeq) return;
    logView.value = view;
    logError.value = undefined;
    if (view.job.status !== "running") {
      stopLogPoll();
    }
  } catch (err) {
    if (token !== logSeq) return;
    if (!silent) logError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (token === logSeq && !silent) logLoading.value = false;
  }
}

const openInRunning = computed(() =>
  props.openJobId !== undefined && props.jobs.some((j) => j.job.id === props.openJobId),
);

watch(
  [() => props.projectId, () => props.openJobId],
  ([pid, jobId]) => {
    stopLogPoll();
    confirmKillId.value = undefined;
    killing.error.value = undefined;
    logView.value = undefined;
    logError.value = undefined;
    if (!pid || !jobId) return;
    void fetchLog(jobId, pid);
    logPollTimer = setInterval(() => {
      if (openInRunning.value) {
        void fetchLog(jobId, pid, true);
      }
    }, 2000);
  },
  { immediate: true },
);

watch(openInRunning, (nowRunning, wasRunning) => {
  if (wasRunning && !nowRunning && props.projectId && props.openJobId) {
    stopLogPoll();
    void fetchLog(props.openJobId, props.projectId, true);
  }
});

onUnmounted(() => {
  stopTimer();
  stopLogPoll();
});

function toggle(id: string): void {
  emit("update:openJobId", props.openJobId === id ? undefined : id);
}

function elapsed(startedAt: number): string {
  return formatElapsedSeconds((nowMs.value - startedAt) / 1000);
}

function statusLabel(status: JobStatus, exitCode?: number): string {
  if (status === "running") return "运行中";
  if (status === "killed") return "已终止";
  if (status === "interrupted") return "被打断";
  return exitCode !== undefined ? `退出码 ${exitCode}` : "已结束";
}

async function killJob(jobId: JobId): Promise<void> {
  const pid = props.projectId;
  if (!pid) return;
  const ok = await killing.run(async () => {
    await props.client.call("POST /api/projects/:project/jobs/:job/kill", {
      project: pid,
      job: jobId,
    });
  });
  if (ok) {
    confirmKillId.value = undefined;
    showToast(`已终止后台作业 ${jobId}`);
    await fetchLog(jobId, pid, true);
  }
}
</script>

<template>
  <div v-if="openJobId && !openInRunning" class="jobs">
    <div class="job open">
      <button
        type="button"
        class="job-row"
        :title="logView?.job.command ?? openJobId"
        :aria-expanded="true"
        @click="$emit('update:openJobId', undefined)"
      >
        <StageGlyph :stage="logView?.job.status === 'killed' || logView?.job.status === 'interrupted' ? 'blocked' : 'done'" />
        <span class="job-cmd">{{ logView?.job.command ?? `作业 ${openJobId}` }}</span>
        <span class="job-sub">
          <span v-if="logView" class="t-id">{{ logView.job.ticketId }}</span>
          <span>{{ logView ? statusLabel(logView.job.status, logView.job.exitCode) : openJobId }}</span>
          <span class="spacer" />
          <span class="num">{{ openJobId }}</span>
        </span>
      </button>

      <p v-if="logError" class="error job-note">{{ logError }}</p>
      <div v-else-if="logLoading && !logView" class="job-note"><Skeleton /></div>
      <template v-else-if="logView">
        <pre v-tail class="job-log">{{ logView.content || "（暂无输出）" }}</pre>
        <p v-if="logView.truncated" class="job-note">仅最近 200 行</p>
      </template>

      <div class="job-actions">
        <button
          v-if="logView"
          type="button"
          class="btn sm"
          @click="$emit('open-ticket', logView.job.ticketId)"
        >
          打开 {{ logView.job.ticketId }}
        </button>
        <span class="spacer" />
        <button
          type="button"
          class="btn sm ghost"
          @click="$emit('update:openJobId', undefined)"
        >
          收起
        </button>
      </div>
    </div>
  </div>

  <p v-if="jobs.length === 0 && (!openJobId || openInRunning)" class="rail-empty">没有后台作业</p>

  <template v-else-if="jobs.length > 0">
    <div class="jobs">
      <div
        v-for="item in jobs"
        :key="item.job.id"
        class="job"
        :class="{ open: openJobId === item.job.id }"
      >
        <button
          type="button"
          class="job-row"
          :title="item.job.command"
          :aria-expanded="openJobId === item.job.id"
          @click="toggle(item.job.id)"
        >
          <StageGlyph stage="jobs" />
          <span class="job-cmd">{{ item.job.command }}</span>
          <span class="job-sub">
            <span class="t-id">{{ item.ticket.id }}</span>
            <span class="ellipsis">{{ item.ticket.title }}</span>
            <span class="spacer" />
            <span class="num">{{ item.job.id }} · {{ elapsed(item.job.startedAt) }}</span>
          </span>
        </button>
        <template v-if="openJobId === item.job.id">
          <p v-if="logError" class="error job-note">{{ logError }}</p>
          <div v-else-if="logLoading && !logView" class="job-note"><Skeleton /></div>
          <template v-else-if="logView">
            <pre v-tail class="job-log">{{ logView.content || "（暂无输出）" }}</pre>
            <p v-if="logView.truncated" class="job-note">仅最近 200 行</p>
          </template>
          <p v-if="killing.error.value" class="error job-note">{{ killing.error.value }}</p>
          <div class="job-actions">
            <button
              type="button"
              class="btn sm"
              @click="$emit('open-ticket', item.ticket.id)"
            >
              打开 {{ item.ticket.id }}
            </button>
            <span class="spacer" />
            <template v-if="confirmKillId === item.job.id">
              <button
                type="button"
                class="btn sm ghost"
                :disabled="killing.busy.value"
                @click="confirmKillId = undefined"
              >
                取消
              </button>
              <button
                type="button"
                class="btn sm danger"
                :disabled="killing.busy.value"
                @click="killJob(item.job.id)"
              >
                {{ killing.busy.value ? "正在终止…" : "确认终止" }}
              </button>
            </template>
            <button
              v-else
              type="button"
              class="btn sm danger"
              :disabled="killing.busy.value"
              @click="
                killing.error.value = undefined;
                confirmKillId = item.job.id;
              "
            >
              终止
            </button>
          </div>
        </template>
      </div>
    </div>
  </template>
</template>
