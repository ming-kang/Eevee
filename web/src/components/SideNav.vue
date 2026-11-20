<script setup lang="ts">
import type { ProjectSummary } from "@shared/api/contract.ts";
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import type { RunSummary } from "@shared/contracts/index.ts";
import type { BoardState } from "../engine-data.ts";
import { countPendingQuestions } from "../board.ts";
import { t } from "../i18n.ts";
import {
  deriveProjectState,
  filterSidebarProjects,
  type ProjectRowState,
  type SidebarProjectEntry,
} from "../projects.ts";
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
  paletteShortcut: string;
  statusError?: string;
  streamState?: StreamState;
}>();

const emit = defineEmits<{
  navigate: [];
  "new-project": [];
  "open-palette": [];
  "hover-show": [payload: { pid: string; top: number; left: number }];
  "hover-hide": [];
}>();

const EXPAND_KEY = "eevee.sideExpanded";

function loadExpandedMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPAND_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

const expandedOverrides = reactive<Record<string, boolean>>(loadExpandedMap());

function saveExpandedMap(): void {
  try {
    localStorage.setItem(EXPAND_KEY, JSON.stringify(expandedOverrides));
  } catch {}
}

function isProjectExpanded(entry: SidebarProjectEntry, state: ProjectRowState): boolean {
  if (entry.forceExpand) return true;
  const override = expandedOverrides[entry.project.id];
  if (override !== undefined) return override;
  return props.currentPid === entry.project.id || state.kind === "user";
}

function toggleProjectExpand(entry: SidebarProjectEntry, state: ProjectRowState): void {
  const next = !isProjectExpanded(entry, state);
  expandedOverrides[entry.project.id] = next;
  saveExpandedMap();
}

const searchQuery = ref("");
const searchInput = ref<HTMLInputElement>();

const filteredEntries = computed(() =>
  filterSidebarProjects(props.projects, props.boards, searchQuery.value),
);

const controlProject = computed(() => props.projects.find((p) => p.id === props.controlPid));

const attentionTotal = computed(() =>
  props.projects.reduce((total, project) => {
    const board = props.boards[project.id]?.board;
    return total + countPendingQuestions(board) + (board?.router.failure ? 1 : 0);
  }, 0),
);

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

function clearSearch(): void {
  searchQuery.value = "";
  searchInput.value?.focus();
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && searchQuery.value !== "") {
    event.preventDefault();
    event.stopPropagation();
    searchQuery.value = "";
  }
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
    <a class="brand" :href="formatRoute({ name: 'home' })" @click="$emit('navigate')">
      <BrandLogo />
      <span class="brand-name">Eevee</span>
    </a>
    <span class="spacer" />
    <button
      type="button"
      class="btn ghost sm icon"
      :title="t('New project')"
      :aria-label="t('New project')"
      @click="
        hideHoverImmediate();
        $emit('new-project');
      "
    >
      <Icon name="folderPlus" size="sm" />
    </button>
  </div>

  <div class="side-tools">
    <div class="side-search">
      <Icon name="search" size="xs" class="side-search-icon" />
      <input
        ref="searchInput"
        v-model="searchQuery"
        type="search"
        class="side-search-input"
        :placeholder="t('Filter projects or tickets…')"
        :aria-label="t('Filter projects or tickets…')"
        autocomplete="off"
        spellcheck="false"
        @keydown="onSearchKeydown"
      />
      <button
        v-if="searchQuery !== ''"
        type="button"
        class="side-search-clear"
        :aria-label="t('Clear filter')"
        @click="clearSearch"
      >
        <Icon name="x" size="xs" />
      </button>
      <button
        v-else
        type="button"
        class="side-search-kbd"
        :title="t('Search ({key})', { key: paletteShortcut })"
        :aria-label="t('Search ({key})', { key: paletteShortcut })"
        @click="
          hideHoverImmediate();
          $emit('open-palette');
        "
      >
        {{ paletteShortcut }}
      </button>
    </div>

    <a
      v-if="searchQuery.trim() === ''"
      class="nav-row"
      :class="{ on: route.name === 'home' }"
      :href="formatRoute({ name: 'home' })"
      :aria-current="route.name === 'home' ? 'page' : undefined"
      @click="$emit('navigate')"
    >
      <Icon name="home" size="sm" />
      <span class="label">{{ t("Home") }}</span>
      <span v-if="attentionTotal > 0" class="count user">{{ attentionTotal }}</span>
    </a>
  </div>

  <div v-if="projects.length > 0" class="side-h">
    <span>{{ t("Projects") }}</span>
    <span class="side-h-count">{{ filteredEntries.length }}</span>
  </div>

  <div class="side-scroll" @scroll="hideHoverImmediate">
    <ProjectRow
      v-for="entry in filteredEntries"
      :key="entry.project.id"
      :project="entry.project"
      :state="stateOf(entry.project)"
      :tickets="entry.tickets"
      :expanded="isProjectExpanded(entry, stateOf(entry.project))"
      :now-ms="nowMs"
      :active="route.name === 'chat' && currentPid === entry.project.id"
      :current="'pid' in route && route.pid === entry.project.id"
      :active-ticket-id="
        route.name === 'worker' && route.pid === entry.project.id ? route.tid : undefined
      "
      :href="formatRoute({ name: 'chat', pid: entry.project.id })"
      @select="
        hideHoverImmediate();
        $emit('navigate');
      "
      @toggle-expand="toggleProjectExpand(entry, stateOf(entry.project))"
      @hover-enter="onHoverEnter(entry.project.id, $event)"
      @hover-leave="onHoverLeave($event, $event.currentTarget)"
    />
    <p v-if="projects.length > 0 && filteredEntries.length === 0" class="hint side-note">
      {{ t("Nothing matches.") }}
    </p>
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
