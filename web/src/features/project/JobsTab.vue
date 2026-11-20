<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { JobLogView } from "@shared/protocol/contract.ts";
import type { JobId } from "@shared/domain/index.ts";
import { computed, onUnmounted, ref, watch } from "vue";
import type { RunningJobItem } from "../../lib/board.ts";
import { vTail } from "../../composables/dom.ts";
import { errorText } from "../../lib/errors.ts";
import { t } from "../../lib/i18n.ts";
import { jobStatusText } from "../../lib/labels.ts";
import { useSubmit } from "../../composables/submit.ts";
import { formatElapsedSeconds } from "../../lib/time.ts";
import { showToast } from "../../composables/toasts.ts";
import Skeleton from "../../ui/Skeleton.vue";
import Icon from "../../ui/Icon.vue";
import StageGlyph from "./StageGlyph.vue";
import Button from "../../ui/Button.vue";
import { displayId } from "../../lib/ids.ts";
import { ID_TEXT } from "./stage.ts";

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
    if (!silent) logError.value = errorText(err);
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
    showToast(t("Stopped background job {job}", { job: jobId }));
    await fetchLog(jobId, pid, true);
  }
}
</script>

<template>
  <div v-if="openJobId && !openInRunning" class="flex flex-col gap-1">
    <div class="rounded-lg transition-[background-color,box-shadow] duration-(--ev-regular) ease-(--ev-ease) border border-border bg-surface shadow-(--ev-shadow-card)">
      <button
        type="button"
        class="job-row grid w-full grid-cols-[var(--ev-icon-sm)_minmax(0,1fr)] items-center gap-x-2.25 gap-y-px rounded-md px-2.5 py-1.5 text-left transition-colors pointer-coarse:min-h-10 focus-visible:shadow-(--ring-inset)"
        :title="logView?.job.command ?? openJobId"
        :aria-expanded="true"
        @click="$emit('update:openJobId', undefined)"
      >
        <StageGlyph :stage="logView?.job.status === 'killed' || logView?.job.status === 'interrupted' ? 'blocked' : 'done'" />
        <span class="truncate font-mono text-xs leading-[1.5] font-medium">{{ logView?.job.command ?? t("Job {id}", { id: displayId(openJobId ?? "") }) }}</span>
        <span class="col-start-2 flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
          <span v-if="logView" :class="ID_TEXT">{{ displayId(logView.job.ticketId) }}</span>
          <span>{{ logView ? jobStatusText(logView.job) : displayId(openJobId) }}</span>
          <span class="spacer" />
          <span class="flex-none">{{ displayId(openJobId) }}</span>
        </span>
      </button>

      <p v-if="logError" class="error px-3 pb-1.5 text-xs">{{ logError }}</p>
      <div v-else-if="logLoading && !logView" class="px-3 pb-1.5 text-xs text-fg-subtle"><Skeleton /></div>
      <template v-else-if="logView">
        <pre v-tail class="mx-2.5 mb-2 max-h-60 overflow-auto rounded-lg border border-border bg-(--ev-code) px-3 py-2.5 font-mono text-xs leading-[1.6] break-words whitespace-pre-wrap text-fg animate-[ev-fade_var(--ev-regular)_var(--ev-ease)]">{{ logView.content || t("(no output yet)") }}</pre>
        <p v-if="logView.truncated" class="px-3 pb-1.5 text-xs text-fg-subtle">{{ t("Last 200 lines only") }}</p>
      </template>

      <div class="flex items-center gap-1.5 px-2.5 pb-2.5">
        <Button v-if="logView" size="sm" @click="$emit('open-ticket', logView.job.ticketId)">
          {{ t("Open {ticket}", { ticket: logView.job.ticketId }) }}
        </Button>
        <span class="spacer" />
        <Button variant="ghost" size="sm" @click="$emit('update:openJobId', undefined)">
          {{ t("Hide") }}
        </Button>
      </div>
    </div>
  </div>

  <div v-if="jobs.length === 0 && (!openJobId || openInRunning)" class="flex flex-col items-center gap-2 px-6 py-12 text-center">
    <Icon name="term" size="lg" class="mb-1 text-fg-subtle" />
    <h3 class="text-sm font-medium text-fg-muted">{{ t("No background jobs") }}</h3>
    <p class="max-w-64 text-xs leading-5 text-fg-subtle">{{ t("Worker commands appear here.") }}</p>
  </div>

  <template v-else-if="jobs.length > 0">
    <div class="flex flex-col gap-1">
      <div
        v-for="item in jobs"
        :key="item.job.id"
        class="rounded-lg transition-[background-color,box-shadow] duration-(--ev-regular) ease-(--ev-ease)"
        :class="openJobId === item.job.id ? 'border border-border bg-surface shadow-(--ev-shadow-card)' : '[&>.job-row:hover]:bg-hover'"
      >
        <button
          type="button"
          class="job-row grid w-full grid-cols-[var(--ev-icon-sm)_minmax(0,1fr)] items-center gap-x-2.25 gap-y-px rounded-md px-2.5 py-1.5 text-left transition-colors pointer-coarse:min-h-10 focus-visible:shadow-(--ring-inset)"
          :title="item.job.command"
          :aria-expanded="openJobId === item.job.id"
          @click="toggle(item.job.id)"
        >
          <StageGlyph stage="jobs" />
          <span class="truncate font-mono text-xs leading-[1.5] font-medium">{{ item.job.command }}</span>
          <span class="col-start-2 flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
            <span :class="ID_TEXT">{{ displayId(item.ticket.id) }}</span>
            <span class="ellipsis">{{ item.ticket.title }}</span>
            <span class="spacer" />
            <span class="flex-none">{{ displayId(item.job.id) }} · {{ elapsed(item.job.startedAt) }}</span>
          </span>
        </button>
        <template v-if="openJobId === item.job.id">
          <p v-if="logError" class="error px-3 pb-1.5 text-xs">{{ logError }}</p>
          <div v-else-if="logLoading && !logView" class="px-3 pb-1.5 text-xs text-fg-subtle"><Skeleton /></div>
          <template v-else-if="logView">
            <pre v-tail class="mx-2.5 mb-2 max-h-60 overflow-auto rounded-lg border border-border bg-(--ev-code) px-3 py-2.5 font-mono text-xs leading-[1.6] break-words whitespace-pre-wrap text-fg animate-[ev-fade_var(--ev-regular)_var(--ev-ease)]">{{ logView.content || t("(no output yet)") }}</pre>
            <p v-if="logView.truncated" class="px-3 pb-1.5 text-xs text-fg-subtle">{{ t("Last 200 lines only") }}</p>
          </template>
          <p v-if="killing.error.value" class="error px-3 pb-1.5 text-xs">{{ killing.error.value }}</p>
          <div class="flex items-center gap-1.5 px-2.5 pb-2.5">
            <Button size="sm" @click="$emit('open-ticket', item.ticket.id)">
              {{ t("Open {ticket}", { ticket: item.ticket.id }) }}
            </Button>
            <span class="spacer" />
            <template v-if="confirmKillId === item.job.id">
              <Button variant="ghost" size="sm" :disabled="killing.busy.value" @click="confirmKillId = undefined">
                {{ t("Cancel") }}
              </Button>
              <Button variant="danger" size="sm" :disabled="killing.busy.value" @click="killJob(item.job.id)">
                {{ killing.busy.value ? t("Stopping…") : t("Stop it") }}
              </Button>
            </template>
            <Button v-else variant="danger" size="sm" :disabled="killing.busy.value" @click="
                killing.error.value = undefined;
                confirmKillId = item.job.id;
              ">
              {{ t("Stop") }}
            </Button>
          </div>
        </template>
      </div>
    </div>
  </template>
</template>
