<script setup lang="ts">
import type { ProjectSummary } from "@shared/api/contract.ts";
import type { ProjectRowState } from "../projects.ts";
import { formatRelativeTime } from "../time.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";

defineProps<{
  project: ProjectSummary;
  state: ProjectRowState;
  active: boolean;
  current: boolean;
  href: string;
  nowMs?: number;
}>();

defineEmits<{
  select: [];
  "hover-enter": [el: HTMLElement];
  "hover-leave": [event: MouseEvent];
}>();
</script>

<template>
  <a
    class="p-row"
    :class="{ on: active, cur: current }"
    :href="href"
    :aria-label="project.title"
    @click="$emit('select')"
    @mouseenter="$emit('hover-enter', $event.currentTarget as HTMLElement)"
    @mouseleave="$emit('hover-leave', $event)"
  >
    <span class="p-lead"><Icon name="folder" size="sm" /></span>
    <span class="p-tile">{{ project.title.slice(0, 1) || "项" }}</span>
    <span class="p-title">{{ project.title }}</span>
    <span class="p-end" :class="`s-${state.kind}`">
      <span v-if="state.kind === 'user'" class="count user">{{ state.questionCount }}</span>
      <StageGlyph v-else-if="state.kind === 'bad'" stage="blocked" />
      <StageGlyph v-else-if="state.kind === 'run'" stage="working" />
      <span v-else-if="state.activeAt !== undefined" class="p-time">
        {{ formatRelativeTime(state.activeAt, nowMs, "short") }}
      </span>
    </span>
  </a>
</template>
