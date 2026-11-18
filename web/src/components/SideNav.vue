<script setup lang="ts">
import type { ProjectSummary } from "@shared/api/contract.ts";
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { RunSummary } from "@shared/contracts/index.ts";
import type { BoardState } from "../engine-data.ts";
import { t } from "../i18n.ts";
import { deriveProjectState, type ProjectRowState } from "../projects.ts";
import { formatRoute, type Route } from "../router.ts";
import type { StreamState } from "../stream.ts";
import BrandLogo from "./BrandLogo.vue";
import ControlTiles from "./ControlTiles.vue";
import Icon from "./Icon.vue";
import ProjectRow from "./ProjectRow.vue";

const props = defineProps<{
  projects: readonly ProjectSummary[];
  boards: Record<string, BoardState | undefined>;
  activeRouterPid?: string;
  activeRouterSummary?: RunSummary;
  route: Route;
  currentPid?: string;
  controlPid?: string;
  sideCollapsed: boolean;
  sideShortcut: string;
  paletteShortcut: string;
  statusError?: string;
  streamState?: StreamState;
}>();

const emit = defineEmits<{
  navigate: [];
  "toggle-side": [];
  "new-project": [];
  "open-palette": [];
  "hover-show": [payload: { pid: string; top: number; left: number }];
  "hover-hide": [];
}>();

const controlProject = computed(() => props.projects.find((p) => p.id === props.controlPid));

const nowMs = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  clockTimer = setInterval(() => {
    nowMs.value = Date.now();
  }, 60_000);
});

function stateOf(project: ProjectSummary): ProjectRowState {
  return deriveProjectState({
    board: props.boards[project.id]?.board,
    router: project.id === props.activeRouterPid ? props.activeRouterSummary : undefined,
    activeAt: project.activeAt,
  });
}

let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
const hoveredPid = ref<string>();

function clearTimers(): void {
  if (showTimer !== undefined) {
    clearTimeout(showTimer);
    showTimer = undefined;
  }
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
}

function positionOf(el: HTMLElement): { top: number; left: number } {
  const rect = el.getBoundingClientRect();
  const vp = el.closest(".viewport")?.getBoundingClientRect();
  if (!vp) return { top: rect.top, left: rect.right + 10 };
  const estimatedHeight = 148;
  return {
    left: rect.right - vp.left + 10,
    top: Math.max(8, Math.min(rect.top - vp.top - 6, vp.height - estimatedHeight - 8)),
  };
}

function onHoverEnter(pid: string, el: HTMLElement): void {
  clearTimers();
  const delay = hoveredPid.value !== undefined ? 60 : 450;
  showTimer = setTimeout(() => {
    if (!el.isConnected) return;
    hoveredPid.value = pid;
    const pos = positionOf(el);
    emit("hover-show", { pid, ...pos });
  }, delay);
}

function onHoverLeave(event: MouseEvent, el?: EventTarget | null): void {
  const current = el as HTMLElement | null;
  if (current && event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
    return;
  }
  clearTimers();
  hideTimer = setTimeout(() => {
    hoveredPid.value = undefined;
    emit("hover-hide");
  }, 120);
}

function hideHoverImmediate(): void {
  clearTimers();
  hoveredPid.value = undefined;
  emit("hover-hide");
}

onUnmounted(() => {
  clearTimers();
  if (clockTimer !== undefined) {
    clearInterval(clockTimer);
    clockTimer = undefined;
  }
});
</script>

<template>
  <div class="side-top">
    <a
      class="brand"
      :href="controlPid ? formatRoute({ name: 'chat', pid: controlPid }) : '#/'"
      @click="$emit('navigate')"
    >
      <BrandLogo />
      <span class="brand-name">Eevee</span>
    </a>
    <span class="spacer" />
    <button
      type="button"
      class="btn ghost sm icon side-toggle"
      :title="
        sideCollapsed
          ? t('Expand sidebar ({key})', { key: sideShortcut })
          : t('Collapse sidebar ({key})', { key: sideShortcut })
      "
      :aria-label="sideCollapsed ? t('Expand sidebar') : t('Collapse sidebar')"
      @click="$emit('toggle-side')"
    >
      <Icon name="sidebar" size="sm" />
    </button>
  </div>

  <div class="side-actions">
    <button
      type="button"
      class="nav-row"
      :title="t('New project')"
      @click="
        hideHoverImmediate();
        $emit('new-project');
      "
    >
      <Icon name="compose" size="sm" />
      <span class="label">{{ t("New project") }}</span>
    </button>
    <button
      type="button"
      class="nav-row"
      :title="t('Search ({key})', { key: paletteShortcut })"
      @click="
        hideHoverImmediate();
        $emit('open-palette');
      "
    >
      <Icon name="search" size="sm" />
      <span class="label">{{ t("Search") }}</span>
      <span class="kbd">{{ paletteShortcut }}</span>
    </button>
  </div>

  <div v-if="projects.length > 0" class="side-h">{{ t("Projects") }}</div>

  <div class="side-scroll" @scroll="hideHoverImmediate">
    <ProjectRow
      v-for="project in projects"
      :key="project.id"
      :project="project"
      :state="stateOf(project)"
      :now-ms="nowMs"
      :active="(route.name === 'chat' || route.name === 'worker') && currentPid === project.id"
      :current="'pid' in route && route.pid === project.id"
      :href="formatRoute({ name: 'chat', pid: project.id })"
      @select="
        hideHoverImmediate();
        $emit('navigate');
      "
      @hover-enter="onHoverEnter(project.id, $event)"
      @hover-leave="onHoverLeave($event, $event.currentTarget)"
    />
    <p v-if="statusError" class="error hint side-note">
      {{ statusError }}
    </p>
  </div>

  <p
    v-if="streamState === 'reconnecting'"
    class="side-conn"
    role="status"
    :title="t('Lost the live connection to the Engine; reconnecting')"
  >
    <span class="dot bad" aria-hidden="true" />
    <span class="label">{{ t("Reconnecting…") }}</span>
  </p>

  <ControlTiles
    :control-pid="controlPid"
    :control-title="controlProject?.title"
    :route-name="route.name"
    @navigate="$emit('navigate')"
  />
</template>
