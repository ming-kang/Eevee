<script setup lang="ts">
import type { ProjectSummary } from "@shared/api/contract.ts";
import type { ProjectRowState } from "../projects.ts";
import { formatRelativeTime } from "../time.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";

defineProps<{
  visible: boolean;
  project: ProjectSummary | undefined;
  state: ProjectRowState | undefined;
  boardLoaded: boolean;
  top: number;
  left: number;
}>();
</script>

<template>
  <div
    class="hovercard"
    :class="{ on: visible && project !== undefined }"
    :style="{ top: `${top}px`, left: `${left}px` }"
    aria-hidden="true"
  >
    <template v-if="project && state">
      <div class="hc-title">{{ project.title }}</div>
      <div class="hc-ws mono">{{ project.workspace }}</div>
      <div class="hc-body">
        <div v-if="state.questionCount > 0" class="hc-line user">
          <span class="dot user" />
          <span>{{ state.questionCount }} 个问题等你回答</span>
        </div>
        <div v-if="state.routerFailed" class="hc-line bad">
          <StageGlyph stage="blocked" />
          <span>Router 上一轮没有完成</span>
        </div>
        <div v-if="!boardLoaded" class="hc-line">
          <StageGlyph stage="idle" />
          <span>正在获取工单状态…</span>
        </div>
        <div v-else-if="state.openCount > 0" class="hc-line">
          <StageGlyph :stage="state.runningTickets > 0 ? 'working' : 'idle'" />
          <span>
            {{ state.openCount }} 张未结
            <template v-if="state.runningTickets > 0"> · {{ state.runningTickets }} 张执行中</template>
            <template v-if="state.jobCount > 0"> · {{ state.jobCount }} 个作业</template>
          </span>
        </div>
        <div v-else class="hc-line">
          <StageGlyph stage="idle" />
          <span>没有未结的工单</span>
        </div>
        <div v-if="state.routerRunning" class="hc-line">
          <Icon name="spinner" size="xs" />
          <span>Router 正在工作</span>
        </div>
      </div>
      <div v-if="state.activeAt !== undefined" class="hc-foot">
        最近活动 {{ formatRelativeTime(state.activeAt) }}
      </div>
    </template>
  </div>
</template>
