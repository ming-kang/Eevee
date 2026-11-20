<script setup lang="ts">
import type { ProjectSummary } from "@shared/protocol/contract.ts";
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { countPendingQuestions, groupTickets, type RailTab } from "./lib/board.ts";
import AppShell from "./features/shell/AppShell.vue";
import BrandLogo from "./ui/BrandLogo.vue";
import CommandPalette from "./features/shell/CommandPalette.vue";
import ConnectPage from "./features/shell/ConnectPage.vue";
import OverviewPage from "./features/overview/OverviewPage.vue";
import Icon from "./ui/Icon.vue";
import ControlDialog from "./features/shell/ControlDialog.vue";
import NewProjectDialog from "./features/shell/NewProjectDialog.vue";
import ProjectHoverCard from "./features/shell/ProjectHoverCard.vue";
import ChatPage from "./features/conversation/ChatPage.vue";
import type { RailMark } from "./features/shell/RailToggle.vue";
import RightRail from "./features/project/RightRail.vue";
import SideNav from "./features/shell/SideNav.vue";
import Toasts from "./ui/Toasts.vue";
import { useConversationWatch, useEngineData } from "./composables/engine-data.ts";
import { summarizeRun } from "@shared/domain/index.ts";
import { errorText } from "./lib/errors.ts";
import { t } from "./lib/i18n.ts";
import { buildPaletteItems, deriveProjectState, readProjectSeen, type PaletteItem } from "./lib/projects.ts";
import { controlProjectId, formatRoute, type BackgroundRoute, type Route, resolveRoute, retainBackgroundRoute, routerProjectId } from "./lib/router.ts";
import { type SessionInfo, Unauthorized, openSession } from "./lib/session.ts";
import { useTheme } from "./composables/theme.ts";
import { useNotifications } from "./composables/use-notifications.ts";
import Button from "./ui/Button.vue";

const SIDE_KEY = "eevee.sideCollapsed";
const RAIL_KEY = "eevee.railCollapsed";
const PROJECT_KEY = "eevee.project";
const SEEN_KEY = "eevee.projectSeen";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
const paletteShortcut = isMac ? "⌘K" : "Ctrl K";
const sideShortcut = isMac ? "⌘B" : "Ctrl B";
const railShortcut = isMac ? "⌘⌥B" : "Ctrl Alt B";

const { toggleTheme } = useTheme();

const session = shallowRef<SessionInfo>();
const connecting = ref(true);
const authError = ref<string>();
const networkError = ref<string>();
const hash = ref("");
const lastPid = ref(localStorage.getItem(PROJECT_KEY) ?? "");
const projectSeen = ref(readProjectSeen(localStorage.getItem(SEEN_KEY)));
const pageVisible = ref(document.visibilityState === "visible");

function onVisibilityChange(): void {
  pageVisible.value = document.visibilityState === "visible";
}
const sideCollapsed = ref(localStorage.getItem(SIDE_KEY) === "true");
const railCollapsed = ref(localStorage.getItem(RAIL_KEY) === "true");
const drawer = ref<"side" | "rail" | null>(null);
const railTab = ref<RailTab>("tickets");
const railMaximized = ref(false);
const openJobId = ref<string | undefined>(undefined);
const newProjectOpen = ref(false);
const paletteOpen = ref(false);

const hoverState = ref<{ visible: boolean; pid?: string; top: number; left: number }>({
  visible: false,
  top: 0,
  left: 0,
});

const engine = useEngineData(session);

function hideHover(): void {
  if (hoverState.value.visible) {
    hoverState.value = { ...hoverState.value, visible: false };
  }
}

function showHover(payload: { pid: string; top: number; left: number }): void {
  if (paletteOpen.value || newProjectOpen.value) return;
  hoverState.value = { visible: true, ...payload };
}

function onHashChange(): void {
  const previous = route.value;
  hash.value = location.hash;
  drawer.value = null;
  paletteOpen.value = false;
  newProjectOpen.value = false;
  hideHover();
  const next = resolveRoute(hash.value);
  if (next.name === "worker" || (previous.name === "worker" && next.name === "chat" && previous.pid === next.pid)) openRail();
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (navigationRoute.value.name === "control") return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    if (!session.value || route.value.name === "connect") return;
    event.preventDefault();
    hideHover();
    newProjectOpen.value = false;
    drawer.value = null;
    paletteOpen.value = !paletteOpen.value;
  }
}

async function connect(): Promise<void> {
  connecting.value = true;
  authError.value = undefined;
  networkError.value = undefined;
  try {
    const opened = await openSession();
    if (location.hash === "") history.replaceState(null, "", formatRoute({ name: "overview" }));
    hash.value = location.hash;
    session.value = opened;
  } catch (error) {
    if (error instanceof Unauthorized) authError.value = error.message;
    else networkError.value = errorText(error);
  } finally {
    connecting.value = false;
  }
}

onMounted(() => {
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("mousedown", hideHover);
  document.addEventListener("visibilitychange", onVisibilityChange);
  void connect();
});

onUnmounted(() => {
  window.removeEventListener("hashchange", onHashChange);
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("mousedown", hideHover);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});

const projects = computed<ProjectSummary[]>(() => engine.projects.value);

const fallbackPid = computed(() => {
  if (projects.value.some((p) => p.id === lastPid.value)) return lastPid.value;
  return projects.value[0]?.id;
});

const navigationRoute = computed<Route>(() => resolveRoute(hash.value, fallbackPid.value));
const route = shallowRef<BackgroundRoute>({ name: "overview" });
const controlContextPid = ref<string>();
const controlRoute = computed(() => navigationRoute.value.name === "control" ? navigationRoute.value : undefined);

watch(
  navigationRoute,
  (next, previous) => {
    route.value = retainBackgroundRoute(next, route.value);
    if (next.name === "control" && (next.pid !== undefined || previous?.name !== "control")) {
      controlContextPid.value = controlProjectId(next, route.value, fallbackPid.value);
    }
    if ("pid" in next && next.pid !== undefined) {
      lastPid.value = next.pid;
      localStorage.setItem(PROJECT_KEY, next.pid);
    }
    if (next.name === "control" || (next.name === "overview" && hash.value === location.hash)) {
      const canonical = formatRoute(next);
      if (location.hash !== canonical) history.replaceState(null, "", canonical);
    }
  },
  { immediate: true },
);

const currentProject = computed(() => {
  const r = route.value;
  if (!("pid" in r)) return undefined;
  return projects.value.find((p) => p.id === r.pid);
});

watch(
  () => currentProject.value?.id,
  () => {
    openJobId.value = undefined;
  },
);

watch(drawer, hideHover);

const routerPid = computed(() => currentProject.value ? routerProjectId(route.value) : undefined);
const routerConversation = useConversationWatch(engine.stream, () =>
  routerPid.value ? { kind: "conversation", project: routerPid.value } : undefined,
);

const activeRouterSummary = computed(() => summarizeRun(routerConversation.live.value));

const currentBoardState = computed(() =>
  currentProject.value ? engine.boardOf(currentProject.value.id) : undefined,
);

const viewedProject = computed(() =>
  (navigationRoute.value.name === "chat" || navigationRoute.value.name === "worker") &&
  pageVisible.value && !paletteOpen.value && !newProjectOpen.value && drawer.value === null &&
  (!railMaximized.value || railCollapsed.value)
    ? currentProject.value?.id : undefined,
);

watch([viewedProject, () => currentBoardState.value?.board], ([pid, board]) => {
  if (!pid || !board) return;
  const at = Date.now();
  if ((projectSeen.value[pid] ?? 0) >= at) return;
  projectSeen.value = { ...projectSeen.value, [pid]: at };
  localStorage.setItem(SEEN_KEY, JSON.stringify(projectSeen.value));
});

const controlPid = computed(() => controlRoute.value ? controlContextPid.value ?? fallbackPid.value : controlProjectId(navigationRoute.value, route.value, fallbackPid.value));
const controlProject = computed(() => projects.value.find((project) => project.id === controlPid.value));
const controlBoard = computed(() => controlProject.value ? engine.boardOf(controlProject.value.id)?.board : undefined);
const withRail = computed(
  () =>
    (route.value.name === "chat" || route.value.name === "worker") &&
    currentProject.value !== undefined,
);

const railMarks = computed<RailMark[]>(() => {
  const board = currentBoardState.value?.board;
  if (!board) return [];
  const questions = countPendingQuestions(board);
  const groups = groupTickets(board.tickets);
  const list: RailMark[] = [];
  if (questions > 0) list.push({ stage: "answer", count: questions });
  if (groups.blocked.length > 0) list.push({ stage: "blocked", count: groups.blocked.length });
  if (groups.review.length > 0) list.push({ stage: "review", count: groups.review.length });
  return list;
});

const hoveredProject = computed(() =>
  hoverState.value.pid ? projects.value.find((p) => p.id === hoverState.value.pid) : undefined,
);

const hoveredBoardState = computed(() =>
  hoverState.value.pid ? engine.boardOf(hoverState.value.pid) : undefined,
);

const hoveredProjectState = computed(() =>
  hoveredProject.value
    ? deriveProjectState({
        board: hoveredBoardState.value?.board,
        router:
          hoveredProject.value.id === currentProject.value?.id
            ? activeRouterSummary.value
            : undefined,
        activeAt: hoveredProject.value.activeAt,
        lastSeenAt: projectSeen.value[hoveredProject.value.id],
      })
    : undefined,
);

const paletteItems = computed(() =>
  buildPaletteItems({
    projects: projects.value,
    boards: engine.boards.value,
    activeProjectId: controlPid.value,
    sideShortcut,
    railShortcut,
  }),
);

function navigate(next: Route): void {
  const target = formatRoute(next);
  drawer.value = null;
  hideHover();
  if (location.hash === target) {
    if (next.name === "worker") openRail();
    return;
  }
  location.hash = target;
}

function setSideCollapsed(collapsed: boolean): void {
  if (collapsed === sideCollapsed.value) return;
  sideCollapsed.value = collapsed;
  localStorage.setItem(SIDE_KEY, String(collapsed));
  hideHover();
}

function toggleSide(): void {
  setSideCollapsed(!sideCollapsed.value);
}

function setRailCollapsed(collapsed: boolean): void {
  if (collapsed === railCollapsed.value) return;
  railCollapsed.value = collapsed;
  localStorage.setItem(RAIL_KEY, String(collapsed));
}

function toggleRail(): void {
  setRailCollapsed(!railCollapsed.value);
}

function openRail(tab?: RailTab, jobId?: string): void {
  if (tab) {
    railTab.value = tab;
    if (route.value.name === "worker") navigate({ name: "chat", pid: route.value.pid });
  }
  if (jobId !== undefined) openJobId.value = jobId;
  setRailCollapsed(false);
  if (window.innerWidth <= 1240) {
    drawer.value = "rail";
  }
}

const activeTicketId = computed(() => route.value.name === "worker" ? route.value.tid : undefined);
watch(
  [() => currentProject.value?.id, activeTicketId],
  ([, ticket]) => {
    if (ticket) openRail();
    else {
      railMaximized.value = false;
    }
  },
  { immediate: true },
);

function openNewProject(): void {
  drawer.value = null;
  hideHover();
  newProjectOpen.value = true;
}

async function onProjectCreated(project: ProjectSummary): Promise<void> {
  await engine.refreshStatus();
  navigate({ name: "chat", pid: project.id });
}

function onPaletteSelect(item: PaletteItem): void {
  if (item.kind === "route") {
    navigate(item.route);
  } else if (item.action === "new-project") {
    openNewProject();
  } else if (item.action === "toggle-theme") {
    toggleTheme();
  } else if (item.action === "toggle-side") {
    toggleSide();
  } else if (item.action === "toggle-rail") {
    toggleRail();
  }
}

useNotifications({
  boards: engine.boards,
  projects: () => projects.value,
  route: () => navigationRoute.value,
  open: navigate,
});

/** Open questions across every project; the document title carries the count. */
const questionTotal = computed(() =>
  projects.value.reduce(
    (total, project) => total + countPendingQuestions(engine.boards.value[project.id]?.board),
    0,
  ),
);

watch(
  questionTotal,
  (count) => {
    document.title = count > 0 ? `(${count}) Eevee` : "Eevee";
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="connecting" class="viewport grid h-full place-items-center [&_svg]:size-7 [&_svg]:animate-[ev-breathe_1.6s_var(--ev-ease)_infinite]" aria-busy="true" :aria-label="t('Connecting to the Engine')">
    <BrandLogo />
    <Toasts />
  </div>
  <div v-else-if="!session || route.name === 'connect'" class="viewport">
    <ConnectPage :reason="authError" :network-error="networkError" @retry="connect" />
    <Toasts />
  </div>
  <AppShell
    v-else
    :with-rail="withRail"
    :worker-active="!!activeTicketId"
    :rail-maximized="railMaximized && !!activeTicketId"
    :side-collapsed="sideCollapsed"
    :rail-collapsed="railCollapsed"
    :side-shortcut="sideShortcut"
    :rail-shortcut="railShortcut"
    :rail-marks="railMarks"
    :drawer="drawer"
    :modal-open="paletteOpen || newProjectOpen || !!controlRoute"
    @open-side-drawer="drawer = 'side'"
    @open-rail-drawer="drawer = 'rail'"
    @open-rail-tickets="openRail('tickets')"
    @close-drawer="drawer = null"
    @toggle-side="toggleSide"
    @toggle-rail="toggleRail"
  >
    <template #sidebar>
      <SideNav
        :projects="projects"
        :boards="engine.boards.value"
        :project-seen="projectSeen"
        :active-router-pid="currentProject?.id"
        :active-router-summary="activeRouterSummary"
        :route="route"
        :current-pid="currentProject?.id"
        :control-pid="controlPid"
        :palette-shortcut="paletteShortcut"
        :status-error="engine.statusError.value"
        :stream-state="engine.streamState.value"
        @navigate="drawer = null"
        @new-project="openNewProject"
        @open-palette="
          drawer = null;
          paletteOpen = true;
        "
        @hover-show="showHover"
        @hover-hide="hideHover"
      />
    </template>

    <template v-if="(route.name === 'chat' || route.name === 'worker') && currentProject">
      <ChatPage
        :key="currentProject.id"
        :client="session.client"
        :project="currentProject"
        :board="currentBoardState?.board"
        :conversation="routerConversation"
        :question-id="route.name === 'chat' ? route.qid : undefined"
        @question-route="navigate({ name: 'chat', pid: currentProject.id, qid: $event })"
        @open-ticket="navigate({ name: 'worker', pid: currentProject.id, tid: $event })"
        @project-changed="engine.refreshStatus()"
      />
    </template>

    <template v-else-if="route.name === 'overview'">
      <OverviewPage
        :projects="projects"
        :boards="engine.boards.value"
        @new-project="openNewProject"
      />
    </template>

    <template v-else-if="route.name === 'chat' || route.name === 'worker'">
      <header class="header" />
      <div class="empty">
        <h3>{{ projects.length === 0 ? t("No projects yet") : t("Project not found") }}</h3>
        <Button v-if="projects.length === 0" variant="primary" @click="openNewProject">
          <Icon name="plus" size="sm" />
          <span>{{ t("New project") }}</span>
        </Button>
      </div>
    </template>

    <template #rail>
      <RightRail
        v-if="currentProject"
        :client="session.client"
        :stream="engine.stream"
        :board="currentBoardState?.board"
        :project="currentProject"
        :error="currentBoardState?.error"
        :tab="railTab"
        :active-ticket-id="activeTicketId"
        :question-id="route.name === 'worker' ? route.qid : undefined"
        :maximized="railMaximized"
        :open-job-id="openJobId"
        @update:tab="railTab = $event"
        @update:open-job-id="openJobId = $event"
        @close-ticket="navigate({ name: 'chat', pid: currentProject.id })"
        @question-route="activeTicketId && navigate({ name: 'worker', pid: currentProject.id, tid: activeTicketId, qid: $event })"
        @toggle-maximize="railMaximized = !railMaximized"
        @open-rail="openRail"
        @open-ticket="navigate({ name: 'worker', pid: currentProject.id, tid: $event })"
      />
    </template>

    <template #overlay>
      <ControlDialog
        :open="!!controlRoute"
        :section="controlRoute?.section ?? 'general'"
        :item="controlRoute?.item"
        :project="controlProject"
        :board="controlBoard"
        :client="session.client"
        :status="engine.status.value"
        :stream-state="engine.streamState.value"
        :refresh-status="engine.refreshStatus"
        @close="navigate(route)"
        @navigate="navigate"
        @open-ticket="controlProject && navigate({ name: 'worker', pid: controlProject.id, tid: $event })"
      />
      <ProjectHoverCard
        :visible="hoverState.visible"
        :project="hoveredProject"
        :state="hoveredProjectState"
        :board-loaded="hoveredBoardState?.board !== undefined"
        :top="hoverState.top"
        :left="hoverState.left"
      />
      <NewProjectDialog
        :open="newProjectOpen"
        :client="session.client"
        :on-created="onProjectCreated"
        @close="newProjectOpen = false"
      />
      <CommandPalette
        :open="paletteOpen"
        :items="paletteItems"
        @close="paletteOpen = false"
        @select="onPaletteSelect"
      />
      <Toasts />
    </template>
  </AppShell>
</template>
