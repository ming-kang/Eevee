<script setup lang="ts">
import type { ProjectSummary } from "@shared/protocol/contract.ts";
import { computed, onUnmounted, ref } from "vue";
import type { RunSummary } from "@shared/domain/index.ts";
import type { BoardState } from "../../composables/engine-data.ts";
import { countPendingQuestions } from "../../lib/board.ts";
import { t } from "../../lib/i18n.ts";
import {
  deriveProjectState,
  filterSidebarProjects,
  type ProjectRowState,
} from "../../lib/projects.ts";
import { formatRoute, type Route } from "../../lib/router.ts";
import type { StreamState } from "../../lib/stream.ts";
import BrandLogo from "../../ui/BrandLogo.vue";
import ControlTiles from "./ControlTiles.vue";
import Icon from "../../ui/Icon.vue";
import ProjectRow from "./ProjectRow.vue";
import Button from "../../ui/Button.vue";

const props = defineProps<{
  projects: readonly ProjectSummary[];
  boards: Record<string, BoardState | undefined>;
  projectSeen: Readonly<Record<string, number>>;
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

const searchQuery = ref("");
const searchInput = ref<HTMLInputElement>();

const filteredEntries = computed(() =>
  filterSidebarProjects(props.projects, searchQuery.value),
);

const attentionTotal = computed(() =>
  props.projects.reduce((total, project) => {
    const board = props.boards[project.id]?.board;
    return total + countPendingQuestions(board) + (board?.openProposals?.length ?? 0) + (board?.router.failure ? 1 : 0);
  }, 0),
);

function stateOf(project: ProjectSummary): ProjectRowState {
  return deriveProjectState({
    board: props.boards[project.id]?.board,
    router: project.id === props.activeRouterPid ? props.activeRouterSummary : undefined,
    activeAt: project.activeAt,
    lastSeenAt: props.projectSeen[project.id],
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
});
</script>

<template>
  <div class="flex h-(--ev-header-h) flex-none items-center gap-1.5 pr-(--ev-ctrl-inset) pl-(--ev-titlebar-left)">
    <a class="flex min-w-0 items-center gap-2 rounded-sm [&_svg]:size-5 [&_svg]:flex-none" :href="formatRoute({ name: 'overview' })" @click="$emit('navigate')">
      <BrandLogo />
      <span class="text-base font-medium tracking-[-0.018em] text-fg">Eevee</span>
    </a>
    <span class="spacer" />
    <Button variant="ghost" size="sm" icon :title="t('New project')" :aria-label="t('New project')" @click="
        hideHoverImmediate();
        $emit('new-project');
      ">
      <Icon name="folderPlus" size="sm" />
    </Button>
  </div>

  <div class="flex flex-none flex-col gap-1.5 px-2.5 pt-2.5 pb-1">
    <div class="flex h-7 items-center gap-1.5 rounded-sm border border-border bg-surface pr-1.25 pl-2 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-(--ring-field)">
      <Icon name="search" size="xs" class="flex-none text-fg-subtle" />
      <input
        ref="searchInput"
        v-model="searchQuery"
        type="search"
        class="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-fg focus:shadow-none focus-visible:shadow-none [&::-webkit-search-cancel-button]:hidden"
        :placeholder="t('Filter projects…')"
        :aria-label="t('Filter projects…')"
        autocomplete="off"
        spellcheck="false"
        @keydown="onSearchKeydown"
      />
      <button
        v-if="searchQuery !== ''"
        type="button"
        class="inline-grid size-5 place-items-center rounded-xs text-fg-subtle hover:bg-hover hover:text-fg"
        :aria-label="t('Clear filter')"
        @click="clearSearch"
      >
        <Icon name="x" size="xs" />
      </button>
      <button
        v-else
        type="button"
        class="side-search-kbd h-4.5 flex-none rounded-xs bg-surface-2 px-1.25 text-2xs leading-none font-medium text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
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
      class="flex h-8 w-full flex-none items-center gap-2.25 rounded-md pr-2 pl-2.25 text-left text-sm font-medium tracking-(--ev-tracking) text-fg transition-[background-color,box-shadow] focus-visible:shadow-(--ring-inset) pointer-coarse:h-9.5 [&_.ico]:inline-flex [&_.ico]:flex-none [&_.ico]:transition-colors"
      :class="route.name === 'overview' ? 'bg-selected [--ev-glyph-cut:var(--selected)] [&_.ico]:text-fg' : 'hover:bg-hover [&_.ico]:text-fg-subtle'"
      :href="formatRoute({ name: 'overview' })"
      :aria-label="attentionTotal > 0 ? `${t('Overview')} · ${attentionTotal}` : t('Overview')"
      :aria-current="route.name === 'overview' ? 'page' : undefined"
      @click="$emit('navigate')"
    >
      <span class="grid w-5 flex-none place-items-center" aria-hidden="true">
        <span v-if="attentionTotal > 0" class="count user">{{ attentionTotal > 99 ? "99+" : attentionTotal }}</span>
        <Icon v-else name="home" size="sm" />
      </span>
      <span class="min-w-0 flex-1 truncate">{{ t("Overview") }}</span>
    </a>
  </div>

  <div v-if="projects.length > 0" class="group/ph flex h-7 flex-none items-center justify-between pr-2 pl-3.5 pt-1.5 text-xs font-medium text-fg-subtle">
    <span>{{ t("Projects") }}</span>
    <Button
      variant="ghost"
      size="sm"
      icon
      class="size-5 opacity-0 transition-opacity group-hover/ph:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      :title="t('New project')"
      :aria-label="t('New project')"
      @click="$emit('new-project')"
    >
      <Icon name="plus" size="xs" />
    </Button>
  </div>

  <div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pt-1 pb-3" @scroll="hideHoverImmediate">
    <ProjectRow
      v-for="project in filteredEntries"
      :key="project.id"
      :project="project"
      :state="stateOf(project)"
      :active="currentPid === project.id"
      :href="formatRoute({ name: 'chat', pid: project.id })"
      @select="
        hideHoverImmediate();
        $emit('navigate');
      "
      @hover-enter="onHoverEnter(project.id, $event)"
      @hover-leave="onHoverLeave($event, $event.currentTarget)"
    />
    <p v-if="projects.length > 0 && filteredEntries.length === 0" class="hint px-2.5 py-1.5">
      {{ t("Nothing matches.") }}
    </p>
    <p v-if="statusError" class="error hint px-2.5 py-1.5">
      {{ statusError }}
    </p>
  </div>

  <p
    v-if="streamState === 'reconnecting'"
    class="mx-2.5 mb-1.5 flex flex-none items-center gap-2 rounded-sm bg-danger-soft px-2.5 py-1.75 text-xs text-danger"
    role="status"
    :title="t('Lost the live connection to the Engine; reconnecting')"
  >
    <span class="dot bad" aria-hidden="true" />
    <span class="label">{{ t("Reconnecting…") }}</span>
  </p>

  <ControlTiles
    :pending-proposals="controlPid ? boards[controlPid]?.board?.openProposals?.length : undefined"
    @navigate="$emit('navigate')"
  />
</template>
