<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { focusFirst, useFocusReturn } from "../../composables/focus.ts";
import { t } from "../../lib/i18n.ts";
import {
  dismissDrawer,
  drawerFade,
  fitRail,
  fitSidebar,
  RAIL,
  readWidth,
  SIDE,
  scaledColumn,
} from "../../lib/layout.ts";
import { useTypography } from "../../composables/theme.ts";
import { TEXT_SIZE } from "../../lib/typography.ts";
import Icon from "../../ui/Icon.vue";
import RailToggle, { type RailMark } from "./RailToggle.vue";
import Sash from "../../ui/Sash.vue";
import Button from "../../ui/Button.vue";

const props = withDefaults(
  defineProps<{
    withRail: boolean;
    sideCollapsed: boolean;
    railCollapsed: boolean;
    sideShortcut: string;
    railShortcut?: string;
    railMarks?: readonly RailMark[];
    drawer: "side" | "rail" | null;
    modalOpen?: boolean;
  }>(),
  {
    railShortcut: "",
    railMarks: () => [],
    modalOpen: false,
  },
);

const emit = defineEmits<{
  "open-side-drawer": [];
  "open-rail-drawer": [];
  "open-rail-tickets": [];
  "close-drawer": [];
  "toggle-side": [];
  "toggle-rail": [];
}>();

/** Widths at which the rail and the sidebar turn into drawers; they match the container queries in `shell.css`. */
const RAIL_DRAWER = "(max-width: 1240px)";
const SIDE_DRAWER = "(max-width: 760px)";
const RAIL_DRAWER_PX = 1240;
const SIDE_DRAWER_PX = 760;

const SIDE_W_KEY = "eevee.sideW";
const RAIL_W_KEY = "eevee.railW";

const viewport = ref<HTMLElement>();
const frame = ref<HTMLElement>();
const sidebar = ref<HTMLElement>();
const rail = ref<HTMLElement>();
const drawerBg = ref<HTMLElement>();
const sideTriggerBtn = ref<{ focus(): void }>();
const railTrigger = ref<InstanceType<typeof RailToggle>>();

const vpWidth = ref(typeof window !== "undefined" ? window.innerWidth : 1280);

const { size: textSize } = useTypography();
const scale = computed(() => textSize.value / TEXT_SIZE.default);
const sideSpec = computed(() => scaledColumn(SIDE, scale.value));
const railSpec = computed(() => scaledColumn(RAIL, scale.value));

const sideW = ref(readWidth(localStorage.getItem(SIDE_W_KEY), SIDE, scale.value));
const railW = ref(readWidth(localStorage.getItem(RAIL_W_KEY), RAIL, scale.value));

const isSideDrawerMode = computed(() => vpWidth.value <= SIDE_DRAWER_PX);
const isRailDrawerMode = computed(() => vpWidth.value <= RAIL_DRAWER_PX);

/** Offcanvas collapse: when collapsed or in drawer mode, the sidebar occupies 0px on the grid. */
const sideColW = computed(() =>
  props.sideCollapsed || isSideDrawerMode.value ? 0 : sideW.value,
);

/** The rail's width on the grid: 0 while it is collapsed or a drawer, so it holds no room. */
const railColW = computed(() =>
  props.withRail && !props.railCollapsed && !isRailDrawerMode.value ? railW.value : 0,
);

const sideVisiblyOpen = computed(() =>
  isSideDrawerMode.value ? props.drawer === "side" : !props.sideCollapsed,
);

const railVisiblyOpen = computed(() =>
  isRailDrawerMode.value ? props.drawer === "rail" : !props.railCollapsed,
);

const frameStyle = computed(() => ({
  "--ev-sidebar-w": `${sideW.value}px`,
  "--ev-rail-w": `${railW.value}px`,
  "--ev-rail-pills": String(railVisiblyOpen.value ? 0 : props.railMarks.length),
}));

const persist = (key: string, value: number) => localStorage.setItem(key, String(value));

function evacuateSidebarFocus(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && sidebar.value?.contains(active)) {
    sideTriggerBtn.value?.focus();
  }
}

function evacuateRailFocus(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && rail.value?.contains(active)) {
    railTrigger.value?.focus();
  }
}

function onSideTriggerClick(): void {
  if (isSideDrawerMode.value) {
    if (props.drawer === "side") emit("close-drawer");
    else emit("open-side-drawer");
    return;
  }
  if (!props.sideCollapsed) evacuateSidebarFocus();
  emit("toggle-side");
}

function onRailTriggerClick(): void {
  if (isRailDrawerMode.value) {
    if (props.drawer === "rail") emit("close-drawer");
    else emit("open-rail-drawer");
    return;
  }
  if (!props.railCollapsed) evacuateRailFocus();
  emit("toggle-rail");
}

watch(
  () => props.sideCollapsed,
  (collapsed) => {
    if (collapsed && !isSideDrawerMode.value) evacuateSidebarFocus();
  },
);

watch(
  () => props.railCollapsed,
  (collapsed) => {
    if (collapsed && !isRailDrawerMode.value) evacuateRailFocus();
  },
);

let dragSide: number | undefined;
let dragRail: number | undefined;

function sashNode(which: "side" | "rail"): HTMLElement | undefined {
  return (
    frame.value?.querySelector<HTMLElement>(which === "side" ? ".sash.s-left" : ".sash.s-right") ??
    undefined
  );
}

function applyDrag(): void {
  const el = frame.value;
  if (!el) return;
  const side = dragSide ?? sideColW.value;
  const tracks = [`${side}px`, "minmax(0, 1fr)"];
  if (railColW.value > 0 || dragRail !== undefined) {
    tracks.push(`${dragRail ?? railW.value}px`);
  }
  el.style.gridTemplateColumns = tracks.join(" ");
  if (dragSide !== undefined) {
    el.style.setProperty("--ev-sidebar-w", `${side}px`);
    sashNode("side")?.style.setProperty("--ev-side-col", `${side}px`);
  }
  if (dragRail !== undefined) {
    el.style.setProperty("--ev-rail-w", `${dragRail}px`);
    sashNode("rail")?.style.setProperty("--ev-rail-w", `${dragRail}px`);
  }
}

function commitDrag(): void {
  const el = frame.value;
  if (el) {
    el.style.removeProperty("grid-template-columns");
    sashNode("side")?.style.removeProperty("--ev-side-col");
    sashNode("rail")?.style.removeProperty("--ev-rail-w");
  }
  if (dragSide !== undefined) {
    sideW.value = dragSide;
    persist(SIDE_W_KEY, dragSide);
  }
  if (dragRail !== undefined) {
    railW.value = dragRail;
    persist(RAIL_W_KEY, dragRail);
  }
  dragSide = undefined;
  dragRail = undefined;
}

function onSideResize(proposed: number): void {
  dragSide = fitSidebar(proposed, vpWidth.value, railColW.value, scale.value);
  applyDrag();
}

function onRailResize(proposed: number): void {
  dragRail = fitRail(proposed, vpWidth.value, sideColW.value, scale.value);
  applyDrag();
}

function onRailStep(proposed: number): void {
  railW.value = fitRail(proposed, vpWidth.value, sideColW.value, scale.value);
  persist(RAIL_W_KEY, railW.value);
}

function onSideStep(proposed: number): void {
  sideW.value = fitSidebar(proposed, vpWidth.value, railColW.value, scale.value);
  persist(SIDE_W_KEY, sideW.value);
}

function onSideReset(): void {
  sideW.value = fitSidebar(
    sideSpec.value.default,
    vpWidth.value,
    railColW.value,
    scale.value,
  );
  persist(SIDE_W_KEY, sideW.value);
}

function onRailReset(): void {
  railW.value = fitRail(railSpec.value.default, vpWidth.value, sideColW.value, scale.value);
  persist(RAIL_W_KEY, railW.value);
}

function reclamp(): void {
  const w = vpWidth.value;
  if (w <= 0) return;
  if (w > SIDE_DRAWER_PX && !props.sideCollapsed) {
    const fit = fitSidebar(sideW.value, w, railColW.value, scale.value);
    if (fit !== sideW.value) {
      sideW.value = fit;
      persist(SIDE_W_KEY, fit);
    }
  }
  if (w > RAIL_DRAWER_PX && props.withRail) {
    const fit = fitRail(railW.value, w, sideColW.value, scale.value);
    if (fit !== railW.value) {
      railW.value = fit;
      persist(RAIL_W_KEY, fit);
    }
  }
}

watch([() => props.withRail, () => props.sideCollapsed, scale], reclamp);

type DrawerDrag = {
  pointerId: number;
  which: "side" | "rail";
  el: HTMLElement;
  dir: 1 | -1;
  startX: number;
  lastX: number;
  lastT: number;
  velocity: number;
  width: number;
};
let dd: DrawerDrag | undefined;

function drawerDown(which: "side" | "rail", event: PointerEvent): void {
  if (props.drawer !== which || dd) return;
  if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
  const el = which === "side" ? sidebar.value : rail.value;
  if (!el) return;
  el.classList.add("dragging");
  drawerBg.value?.classList.add("dragging");
  dd = {
    pointerId: event.pointerId,
    which,
    el,
    dir: which === "side" ? -1 : 1,
    startX: event.clientX,
    lastX: event.clientX,
    lastT: event.timeStamp,
    velocity: 0,
    width: el.offsetWidth,
  };
}

function drawerMove(event: PointerEvent): void {
  if (!dd || event.pointerId !== dd.pointerId) return;
  const dt = event.timeStamp - dd.lastT;
  if (dt > 0) {
    const v = (dd.dir * (event.clientX - dd.lastX)) / dt;
    dd.velocity = 0.6 * dd.velocity + 0.4 * v;
    dd.lastX = event.clientX;
    dd.lastT = event.timeStamp;
  }
  const away = Math.max(0, dd.dir * (event.clientX - dd.startX));
  dd.el.style.transform = `translateX(${dd.dir * away}px)`;
  if (drawerBg.value) drawerBg.value.style.opacity = String(drawerFade(away, dd.width));
}

function drawerUp(event: PointerEvent): void {
  if (!dd || event.pointerId !== dd.pointerId) return;
  const { el, which, dir, width } = dd;
  const away = Math.max(0, dir * (event.clientX - dd.startX));
  const dismiss =
    event.type === "pointerup" && dismissDrawer(away, width, Math.max(0, dd.velocity));
  dd = undefined;
  el.classList.remove("dragging");
  const bg = drawerBg.value;
  bg?.classList.remove("dragging");
  if (dismiss) {
    el.style.transform = which === "side" ? "translateX(-100%)" : "translateX(100%)";
    if (bg) bg.style.opacity = "0";
    emit("close-drawer");
    window.setTimeout(() => {
      el.style.transform = "";
      if (bg) bg.style.opacity = "";
    }, 400);
  } else {
    el.style.transform = "";
    if (bg) bg.style.opacity = "";
  }
}

function dropDrawerDrag(): void {
  if (!dd) return;
  dd.el.style.transform = "";
  dd.el.classList.remove("dragging");
  const bg = drawerBg.value;
  bg?.classList.remove("dragging");
  if (bg) bg.style.opacity = "";
  dd = undefined;
}

watch(
  () => props.drawer,
  (next) => {
    if (next !== dd?.which) dropDrawerDrag();
  },
);

useFocusReturn(
  () => props.drawer !== null,
  () => focusFirst(props.drawer === "side" ? sidebar.value : rail.value),
);

function onKeydown(event: KeyboardEvent): void {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.altKey &&
    event.key.toLowerCase() === "b"
  ) {
    if (!props.withRail) return;
    event.preventDefault();
    onRailTriggerClick();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    onSideTriggerClick();
    return;
  }
  if (event.key === "Escape" && !props.modalOpen && props.drawer !== null) {
    emit("close-drawer");
  }
}

const queries = [window.matchMedia(RAIL_DRAWER), window.matchMedia(SIDE_DRAWER)];
function onBreakpoint(): void {
  const stale =
    (props.drawer === "rail" && !queries[0]?.matches) ||
    (props.drawer === "side" && !queries[1]?.matches);
  if (stale) emit("close-drawer");
}

let widths: ResizeObserver | undefined;

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  for (const query of queries) query.addEventListener("change", onBreakpoint);
  if (viewport.value) {
    vpWidth.value = viewport.value.clientWidth;
    widths = new ResizeObserver(() => {
      vpWidth.value = viewport.value?.clientWidth ?? 0;
      reclamp();
    });
    widths.observe(viewport.value);
  }
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  for (const query of queries) query.removeEventListener("change", onBreakpoint);
  widths?.disconnect();
});
</script>

<template>
  <div ref="viewport" class="viewport">
    <div
      class="side-trigger-anchor"
      :class="{ hidden: drawer === 'rail' && isSideDrawerMode }"
      :inert="drawer === 'rail' && isSideDrawerMode"
    >
      <Button ref="sideTriggerBtn" variant="ghost" size="sm" icon class="side-trigger-btn" :aria-expanded="sideVisiblyOpen" :title="
          sideVisiblyOpen
            ? t('Collapse sidebar ({key})', { key: sideShortcut })
            : t('Expand sidebar ({key})', { key: sideShortcut })
        " :aria-label="sideVisiblyOpen ? t('Collapse sidebar') : t('Expand sidebar')" @click="onSideTriggerClick">
        <Icon :name="sideVisiblyOpen ? 'sidebarClose' : 'sidebar'" size="sm" />
      </Button>
    </div>

    <div
      v-if="withRail"
      class="rail-trigger-anchor"
      :class="{ hidden: drawer === 'side' && isSideDrawerMode }"
      :inert="drawer === 'side' && isSideDrawerMode"
    >
      <RailToggle
        ref="railTrigger"
        :open="railVisiblyOpen"
        :shortcut="railShortcut"
        :marks="railMarks"
        @toggle="onRailTriggerClick"
        @open-tickets="emit('open-rail-tickets')"
      />
    </div>

    <div
      ref="frame"
      class="frame"
      :class="{
        'with-rail': withRail,
        'side-collapsed': sideCollapsed,
        'rail-collapsed': railCollapsed,
      }"
      :style="frameStyle"
    >
      <nav
        ref="sidebar"
        class="sidebar"
        :class="{ open: drawer === 'side', collapsed: sideCollapsed }"
        :aria-label="t('Navigation')"
        :inert="drawer === 'rail' || (isSideDrawerMode ? drawer !== 'side' : sideCollapsed)"
        @pointerdown="drawerDown('side', $event)"
        @pointermove="drawerMove"
        @pointerup="drawerUp"
        @pointercancel="drawerUp"
      >
        <div class="sidebar-inner">
          <slot name="sidebar" />
        </div>
      </nav>
      <main class="main" :inert="drawer !== null">
        <slot />
      </main>
      <aside
        v-if="withRail"
        ref="rail"
        class="rail"
        :class="{ open: drawer === 'rail' }"
        :aria-label="t('Tickets and jobs')"
        :inert="drawer === 'side' || (isRailDrawerMode ? drawer !== 'rail' : railCollapsed)"
        @pointerdown="drawerDown('rail', $event)"
        @pointermove="drawerMove"
        @pointerup="drawerUp"
        @pointercancel="drawerUp"
      >
        <div class="rail-inner">
          <slot name="rail" />
        </div>
      </aside>
      <Sash
        v-if="!sideCollapsed"
        side="left"
        :label="t('Resize sidebar')"
        :min="sideSpec.min"
        :max="sideSpec.max"
        :now="sideColW"
        @resize="onSideResize"
        @dragend="commitDrag"
        @step="onSideStep"
        @reset="onSideReset"
      />
      <Sash
        v-if="withRail && !railCollapsed"
        side="right"
        :label="t('Resize the tickets panel')"
        :min="railSpec.min"
        :max="railSpec.max"
        :now="railW"
        @resize="onRailResize"
        @dragend="commitDrag"
        @step="onRailStep"
        @reset="onRailReset"
      />
    </div>
    <div
      ref="drawerBg"
      class="drawer-bg"
      :class="{ on: drawer !== null }"
      aria-hidden="true"
      @click="$emit('close-drawer')"
    />
    <slot name="overlay" />
  </div>
</template>
