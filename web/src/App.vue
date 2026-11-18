<script setup lang="ts">
import type { ProjectSummary } from "@shared/api/contract.ts";
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import type { RailTab } from "./board.ts";
import AppShell from "./components/AppShell.vue";
import BrandLogo from "./components/BrandLogo.vue";
import CommandPalette from "./components/CommandPalette.vue";
import ConnectPage from "./components/ConnectPage.vue";
import Icon from "./components/Icon.vue";
import MemoryPage from "./components/MemoryPage.vue";
import NewProjectDialog from "./components/NewProjectDialog.vue";
import ProjectHoverCard from "./components/ProjectHoverCard.vue";
import ProjectView from "./components/ProjectView.vue";
import RightRail from "./components/RightRail.vue";
import SettingsPage from "./components/SettingsPage.vue";
import SideNav from "./components/SideNav.vue";
import Toasts from "./components/Toasts.vue";
import UsagePage from "./components/UsagePage.vue";
import { useConversationWatch, useEngineData } from "./engine-data.ts";
import { summarizeRun } from "@shared/contracts/index.ts";
import { errorText } from "./errors.ts";
import { t } from "./i18n.ts";
import { buildPaletteItems, deriveProjectState, type PaletteItem } from "./projects.ts";
import { formatRoute, type Route, resolveRoute } from "./router.ts";
import { type SessionInfo, Unauthorized, openSession } from "./session.ts";
import { useTheme } from "./theme.ts";

const SIDE_KEY = "eevee.sideCollapsed";
const PROJECT_KEY = "eevee.project";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
const paletteShortcut = isMac ? "⌘K" : "Ctrl K";
const sideShortcut = isMac ? "⌘B" : "Ctrl B";

const { toggleTheme } = useTheme();

const session = shallowRef<SessionInfo>();
const connecting = ref(true);
const authError = ref<string>();
const networkError = ref<string>();
const hash = ref("");
const lastPid = ref(localStorage.getItem(PROJECT_KEY) ?? "");
const sideCollapsed = ref(localStorage.getItem(SIDE_KEY) === "true");
const drawer = ref<"side" | "rail" | null>(null);
const railTab = ref<RailTab>("tickets");
const openJobId = ref<string | undefined>(undefined);
const newProjectOpen = ref(false);
const paletteOpen = ref(false);
const memoryModalOpen = ref(false);

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
  hash.value = location.hash;
  drawer.value = null;
  paletteOpen.value = false;
  newProjectOpen.value = false;
  hideHover();
}

function onGlobalKeydown(event: KeyboardEvent): void {
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
  void connect();
});

onUnmounted(() => {
  window.removeEventListener("hashchange", onHashChange);
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("mousedown", hideHover);
});

const projects = computed<ProjectSummary[]>(() => engine.projects.value);

const fallbackPid = computed(() => {
  if (projects.value.some((p) => p.id === lastPid.value)) return lastPid.value;
  return projects.value[0]?.id;
});

const route = computed<Route>(() => resolveRoute(hash.value, fallbackPid.value));

watch(
  route,
  (next) => {
    if ("pid" in next) {
      lastPid.value = next.pid;
      localStorage.setItem(PROJECT_KEY, next.pid);
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

const routerConversation = useConversationWatch(engine.stream, () =>
  currentProject.value ? { kind: "conversation", project: currentProject.value.id } : undefined,
);

const activeRouterSummary = computed(() => summarizeRun(routerConversation.live.value));

const currentBoardState = computed(() =>
  currentProject.value ? engine.boardOf(currentProject.value.id) : undefined,
);

const controlPid = computed(() => ("pid" in route.value ? route.value.pid : fallbackPid.value));
const withRail = computed(
  () =>
    (route.value.name === "chat" || route.value.name === "worker") &&
    currentProject.value !== undefined,
);

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
      })
    : undefined,
);

const paletteItems = computed(() =>
  buildPaletteItems({
    projects: projects.value,
    boards: engine.boards.value,
    activeProjectId: controlPid.value,
    sideShortcut,
  }),
);

function navigate(next: Route): void {
  const target = formatRoute(next);
  drawer.value = null;
  hideHover();
  if (location.hash === target) return;
  location.hash = target;
}

function toggleSide(): void {
  sideCollapsed.value = !sideCollapsed.value;
  localStorage.setItem(SIDE_KEY, String(sideCollapsed.value));
  hideHover();
}

function openRail(tab?: RailTab, jobId?: string): void {
  if (tab) railTab.value = tab;
  if (jobId !== undefined) openJobId.value = jobId;
  if (window.innerWidth <= 1240) {
    drawer.value = "rail";
  }
}

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
  }
}
</script>

<template>
  <div v-if="connecting" class="viewport boot" aria-busy="true" :aria-label="t('正在连接 Engine')">
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
    :side-collapsed="sideCollapsed"
    :drawer="drawer"
    :modal-open="paletteOpen || newProjectOpen || memoryModalOpen"
    @close-drawer="drawer = null"
    @toggle-side="toggleSide"
  >
    <template #sidebar>
      <SideNav
        :projects="projects"
        :boards="engine.boards.value"
        :active-router-pid="currentProject?.id"
        :active-router-summary="activeRouterSummary"
        :route="route"
        :current-pid="currentProject?.id"
        :control-pid="controlPid"
        :side-collapsed="sideCollapsed"
        :side-shortcut="sideShortcut"
        :palette-shortcut="paletteShortcut"
        :status-error="engine.statusError.value"
        :stream-state="engine.streamState.value"
        @navigate="drawer = null"
        @toggle-side="toggleSide"
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
      <ProjectView
        :key="currentProject.id"
        :client="session.client"
        :stream="engine.stream"
        :project="currentProject"
        :board="currentBoardState?.board"
        :router-conversation="routerConversation"
        :ticket-id="route.name === 'worker' ? route.tid : undefined"
        @open-side="drawer = 'side'"
        @open-rail="openRail"
        @open-ticket="navigate({ name: 'worker', pid: currentProject.id, tid: $event })"
        @close-ticket="navigate({ name: 'chat', pid: currentProject.id })"
        @project-changed="engine.refreshStatus()"
      />
    </template>

    <template v-else-if="route.name === 'chat' || route.name === 'worker' || route.name === 'home'">
      <header class="header">
        <button type="button" class="btn ghost sm icon menu-btn" :aria-label="t('菜单')" @click="drawer = 'side'">
          <Icon name="menu" size="sm" />
        </button>
      </header>
      <div class="empty">
        <h3>{{ projects.length === 0 ? t("还没有项目") : t("找不到这个项目") }}</h3>
        <button
          v-if="projects.length === 0"
          type="button"
          class="btn primary"
          @click="openNewProject"
        >
          <Icon name="plus" size="sm" />
          <span>{{ t("新建项目") }}</span>
        </button>
      </div>
    </template>

    <template v-else-if="route.name === 'memory' && currentProject">
      <MemoryPage
        :client="session.client"
        :project="currentProject"
        @open-side="drawer = 'side'"
        @modal-change="memoryModalOpen = $event"
      />
    </template>

    <template v-else-if="route.name === 'usage' && currentProject">
      <UsagePage
        :client="session.client"
        :project="currentProject"
        @open-side="drawer = 'side'"
        @open-ticket="navigate({ name: 'worker', pid: currentProject.id, tid: $event })"
      />
    </template>

    <template v-else-if="route.name === 'memory' || route.name === 'usage'">
      <header class="header">
        <button type="button" class="btn ghost sm icon menu-btn" :aria-label="t('菜单')" @click="drawer = 'side'">
          <Icon name="menu" size="sm" />
        </button>
        <h1>{{ route.name === "memory" ? t("记忆") : t("用量") }}</h1>
      </header>
      <div class="empty">
        <h3>{{ t("找不到这个项目") }}</h3>
      </div>
    </template>

    <template v-else-if="route.name === 'settings'">
      <SettingsPage
        :client="session.client"
        :section="route.section"
        :item="route.item"
        :status="engine.status.value"
        :stream-state="engine.streamState.value"
        :refresh-status="engine.refreshStatus"
        @open-side="drawer = 'side'"
      />
    </template>

    <template #rail>
      <RightRail
        v-if="currentProject"
        :client="session.client"
        :board="currentBoardState?.board"
        :project="currentProject"
        :error="currentBoardState?.error"
        :tab="railTab"
        :has-detail="route.name === 'worker'"
        :active-ticket-id="route.name === 'worker' ? route.tid : undefined"
        :open-job-id="openJobId"
        @update:tab="railTab = $event"
        @update:open-job-id="openJobId = $event"
        @open-ticket="navigate({ name: 'worker', pid: currentProject.id, tid: $event })"
        @close-drawer="drawer = null"
      />
    </template>

    <template #overlay>
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
