<script setup lang="ts">
import type { TicketView } from "@shared/api/contract.ts";
import { formatModel, type ModelDefaults, pickModel } from "@shared/contracts/index.ts";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { effectiveStage } from "../board.ts";
import { STAGE_LABEL } from "../labels.ts";
import { formatRelativeTime } from "../time.ts";
import Icon from "./Icon.vue";
import ReportCard from "./ReportCard.vue";
import StageGlyph from "./StageGlyph.vue";
import TicketRef from "./TicketRef.vue";

const props = defineProps<{
  ticketId?: string;
  view: TicketView | undefined;
  tickets?: readonly TicketView[];
  projectModels?: ModelDefaults;
  loaded: boolean;
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const nowMs = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  timer = setInterval(() => {
    nowMs.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer);
});

const stage = computed(() => (props.view ? effectiveStage(props.view) : undefined));

const sortedReports = computed(() =>
  props.view ? [...props.view.reports].sort((a, b) => b.seq - a.seq) : [],
);

const modelInfo = computed(() => {
  const ticket = props.view?.ticket;
  if (!ticket) return { name: undefined, hint: undefined };
  if (ticket.model) {
    return {
      name: formatModel(ticket.model),
      hint: ticket.modelReason ?? "指定模型",
    };
  }
  const projectDefault = pickModel(ticket.role, props.projectModels);
  if (projectDefault) {
    return {
      name: formatModel(projectDefault),
      hint: "项目默认",
    };
  }
  return {
    name: undefined,
    hint: ticket.role === "dreamer" ? "Dreamer 默认模型" : "Worker 默认模型",
  };
});
</script>

<template>
  <p v-if="!view && !loaded" class="hint" style="padding: 12px 8px">正在加载工单详情…</p>
  <p v-else-if="!view" class="hint" style="padding: 12px 8px">
    找不到工单 {{ ticketId ?? "" }}
  </p>
  <div v-else class="rdetail">
    <div v-if="stage" class="rd-meta">
      <StageGlyph :stage="stage" />
      <span>{{ STAGE_LABEL[stage] }}</span>
      <span>·</span>
      <span>{{ formatRelativeTime(view.ticket.createdAt, nowMs) }}创建</span>
      <template v-if="view.ticket.closedAt">
        <span>·</span>
        <span>{{ formatRelativeTime(view.ticket.closedAt, nowMs) }}结单</span>
      </template>
    </div>

    <dl class="brief col">
      <dt>目标</dt>
      <dd>
        <span>{{ view.ticket.goal || "—" }}</span>
      </dd>

      <template v-if="view.ticket.inputs.length > 0">
        <dt>输入</dt>
        <dd>
          <span
            v-for="(input, index) in view.ticket.inputs"
            :key="index"
            class="mono"
            style="font-size: 12px"
          >
            {{ input }}
          </span>
        </dd>
      </template>

      <template v-if="view.ticket.acceptance.length > 0">
        <dt>验收标准</dt>
        <dd>
          <ul>
            <li v-for="(item, index) in view.ticket.acceptance" :key="index">
              <Icon name="check" size="xs" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </dd>
      </template>

      <template v-if="view.ticket.output">
        <dt>产物</dt>
        <dd>
          <span class="mono" style="font-size: 12px">{{ view.ticket.output }}</span>
        </dd>
      </template>

      <template v-if="view.ticket.deliverTo.length > 0">
        <dt>交付给</dt>
        <dd>
          <span>
            <template v-for="(targetId, index) in view.ticket.deliverTo" :key="targetId">
              <template v-if="index > 0">、</template>
              <TicketRef
                :ticket-id="targetId"
                :tickets="tickets"
                @open-ticket="$emit('open-ticket', $event)"
              />
            </template>
          </span>
          <span class="hint">验收后由引擎直接投递</span>
        </dd>
      </template>

      <dt>模型</dt>
      <dd>
        <span v-if="modelInfo.name" class="mono" style="font-size: 12px">{{ modelInfo.name }}</span>
        <span v-if="modelInfo.hint" class="hint">{{ modelInfo.hint }}</span>
      </dd>

      <template v-if="view.ticket.closeNote">
        <dt>结单说明</dt>
        <dd>
          <span>{{ view.ticket.closeNote }}</span>
        </dd>
      </template>
    </dl>

    <div class="section-h">报告</div>
    <div v-if="sortedReports.length > 0" class="rlist">
      <ReportCard
        v-for="report in sortedReports"
        :key="report.seq"
        :report="report"
        :now-ms="nowMs"
        full
      />
    </div>
    <p v-else class="hint" style="margin: 0">
      还没有报告。Worker 做完或卡住时会交报告给 Router。
    </p>
  </div>
</template>
