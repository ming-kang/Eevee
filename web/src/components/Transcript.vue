<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { GapItem } from "../conversation.ts";
import { formatClockTime } from "../time.ts";
import type { TranscriptDisplayItem } from "../transcript-map.ts";
import AssistantMessage from "./AssistantMessage.vue";
import BashLine from "./BashLine.vue";
import DispatchLine from "./DispatchLine.vue";
import EditLine from "./EditLine.vue";
import EventNote from "./EventNote.vue";
import FailureLine from "./FailureLine.vue";
import Icon from "./Icon.vue";
import ProcessLine from "./ProcessLine.vue";
import ReportCard from "./ReportCard.vue";
import ResetMark from "./ResetMark.vue";
import TicketRef from "./TicketRef.vue";
import UserMessage from "./UserMessage.vue";

const props = withDefaults(
  defineProps<{
    items: readonly TranscriptDisplayItem[];
    tickets?: readonly TicketView[];
    runningJobIds?: ReadonlySet<string>;
    loadingEarlier?: boolean;
    fillingGaps?: boolean;
    retry?: () => Promise<void>;
    loadEarlier?: () => Promise<void>;
    fillGap?: (gap: GapItem) => Promise<void>;
  }>(),
  {
    tickets: () => [],
    runningJobIds: () => new Set<string>(),
    loadingEarlier: false,
    fillingGaps: false,
    retry: undefined,
    loadEarlier: undefined,
    fillGap: undefined,
  },
);

defineEmits<{
  "open-ticket": [ticketId: string];
  "open-detail": [];
  "open-job": [jobId: string];
}>();

const scroller = ref<HTMLElement>();

const tailKey = computed(() => {
  const last = props.items.at(-1);
  if (!last) return "";
  if (last.kind === "assistant") return `${last.key}:${last.text.length}`;
  if (last.kind === "tools") return `${last.key}:${last.steps.map((s) => `${s.status}:${s.output?.length ?? 0}`).join(",")}`;
  if (last.kind === "bash") return `${last.key}:${last.status}:${last.output.length}`;
  return last.key;
});

onMounted(() => {
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
});

watch(tailKey, async () => {
  const el = scroller.value;
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  await nextTick();
  if (nearBottom) el.scrollTop = el.scrollHeight;
});
</script>

<template>
  <div ref="scroller" class="chat">
    <div class="chat-inner">
      <template v-for="item in items" :key="item.key">
        <button
          v-if="item.kind === 'more'"
          type="button"
          class="more-line"
          :disabled="loadingEarlier"
          @click="loadEarlier?.()"
        >
          {{ loadingEarlier ? "正在加载…" : "更早的消息" }}
        </button>
        <button
          v-else-if="item.kind === 'gap'"
          type="button"
          class="more-line"
          :disabled="fillingGaps"
          @click="fillGap?.(item.gap)"
        >
          {{ fillingGaps ? "正在补全…" : "补全缺失的记录" }}
        </button>
        <ResetMark
          v-else-if="item.kind === 'reset'"
          :summary="item.summary"
          :at="item.at"
        />
        <button
          v-else-if="item.kind === 'opening'"
          type="button"
          class="note link"
          title="工单目标、输入、验收标准和项目记忆"
          @click="$emit('open-detail')"
        >
          <Icon name="flag" size="xs" />
          <span>开篇</span>
        </button>
        <UserMessage
          v-else-if="item.kind === 'user'"
          :text="item.text"
          :at="item.at"
          :pending="item.pending"
        />
        <div v-else-if="item.kind === 'qa'" class="u-wrap">
          <div v-if="item.at !== undefined" class="msg-meta">{{ formatClockTime(item.at) }}</div>
          <div class="msg-user">
            <div class="via">{{ item.question }}</div>
            {{ item.answer }}
          </div>
        </div>
        <AssistantMessage
          v-else-if="item.kind === 'assistant'"
          :text="item.text"
          :streaming="item.streaming"
          :tickets="tickets"
          @open-ticket="$emit('open-ticket', $event)"
        />
        <ProcessLine
          v-else-if="item.kind === 'tools'"
          :steps="item.steps"
          :live="item.live"
        />
        <EditLine
          v-else-if="item.kind === 'edit'"
          :action="item.action"
          :path="item.path"
          :status="item.status"
          :diff="item.diff"
          :added="item.added"
          :removed="item.removed"
          :error="item.error"
        />
        <BashLine
          v-else-if="item.kind === 'bash'"
          :command="item.command"
          :status="item.status"
          :output="item.output"
          :exit-code="item.exitCode"
          :ms="item.ms"
          :job-id="item.jobId"
          :at="item.at"
          :running-job-ids="runningJobIds"
          @open-job="$emit('open-job', $event)"
        />
        <ReportCard
          v-else-if="item.kind === 'report'"
          :report="item.report"
        />
        <DispatchLine
          v-else-if="item.kind === 'dispatch'"
          :actions="item.actions"
          :live="item.live"
          :tickets="tickets"
          @open-ticket="$emit('open-ticket', $event)"
        />
        <EventNote
          v-else-if="item.kind === 'event'"
          :event-kind="item.eventKind"
          :ticket-id="item.ticketId"
          :status="item.status"
          :text="item.text"
          :detail="item.detail"
          :tickets="tickets"
          @open-ticket="$emit('open-ticket', $event)"
        />
        <div v-else-if="item.kind === 'idle'" class="idle-mark">
          <span>{{ item.text }}</span>
        </div>
        <FailureLine
          v-else-if="item.kind === 'failure'"
          :text="item.text"
          :retry="retry"
        />
      </template>
      <slot name="tail" />
    </div>
  </div>
</template>
