<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { focusFirst, useFocusReturn } from "../focus.ts";
import { t } from "../i18n.ts";
import {
  RAIL,
  SIDE,
  collapsedSideW,
  dismissDrawer,
  drawerFade,
  fitRail,
  fitSidebar,
  readWidth,
  scaledColumn,
} from "../layout.ts";
import { useTypography } from "../theme.ts";
import { TEXT_SIZE } from "../typography.ts";
import Sash from "./Sash.vue";

const props = defineProps<{
  withRail: boolean;
  sideCollapsed: boolean;
  drawer: "side" | "rail" | null;
  modalOpen?: boolean;
}>();

const emit = defineEmits<{
  "close-drawer": [];
  "toggle-side": [];
  /** The sash asks for an explicit collapsed state (Ctrl/⌘B toggles through "toggle-side"). */
  "collapse-side": [collapsed: boolean];
}>();

/** Widths at which the rail and the sidebar turn into drawers; they match the container queries in `style.css`. */
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

const vpWidth = ref(0);

/** The interface scale: every column limit and the collapsed width multiply by it, so the same
 *  stored pixel width stays meaningful while the columns' room grows with the text size. */
const { size: textSize } = useTypography();
const scale = computed(() => textSize.value / TEXT_SIZE.default);
const sideSpec = computed(() => scaledColumn(SIDE, scale.value));
const railSpec = computed(() => scaledColumn(RAIL, scale.value));
const collapsedW = computed(() => collapsedSideW(scale.value));

const sideW = ref(readWidth(localStorage.getItem(SIDE_W_KEY), SIDE, scale.value));
const railW = ref(readWidth(localStorage.getItem(RAIL_W_KEY), RAIL, scale.value));

/** The sidebar's rendered width: the icon column while collapsed. */
const sideColW = computed(() => (props.sideCollapsed ? collapsedW.value : sideW.value));
/** The rail's width on the grid: 0 while it is a drawer, so it holds no room. */
const railColW = computed(() =>
  props.withRail && vpWidth.value > RAIL_DRAWER_PX ? railW.value : 0,
);
const frameStyle = computed(() => ({
  "--ev-sidebar-w": `${sideW.value}px`,
  "--ev-rail-w": `${railW.value}px`,
}));

const persist = (key: string, value: number) => localStorage.setItem(key, String(value));

// ——— Sash drags ———
// A pointermove must not go through the reactive widths: an inherited custom property on `.frame`
// would restyle the whole subtree each move (and localStorage would write each move too). While a
// drag runs, the columns and the sash's edge marker take imperative writes — `gridTemplateColumns`
// on `.frame` and the positioning custom property on the sash element itself, both leaf-level —
// and the refs + localStorage commit once at the drag's end.
let dragSide: { width: number; collapsed: boolean } | undefined;
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
  const side =
    dragSide === undefined
      ? sideColW.value
      : dragSide.collapsed
        ? collapsedW.value
        : dragSide.width;
  const tracks = [`${side}px`, "minmax(0, 1fr)"];
  if (railColW.value > 0 || dragRail !== undefined) {
    tracks.push(`${dragRail ?? railW.value}px`);
  }
  el.style.gridTemplateColumns = tracks.join(" ");
  if (dragSide !== undefined) {
    sashNode("side")?.style.setProperty("--ev-side-col", `${side}px`);
  }
  if (dragRail !== undefined) {
    sashNode("rail")?.style.setProperty("--ev-rail-w", `${dragRail}px`);
  }
}

/** Hands the columns back to the stylesheet after a drag: the refs' values commit, the inline
 *  custom properties already hold the same widths, so dropping the imperative template leaves
 *  the rendered geometry untouched until Vue's own patch lands. */
function commitDrag(): void {
  const el = frame.value;
  if (el) {
    if (dragSide !== undefined && !dragSide.collapsed) {
      el.style.setProperty("--ev-sidebar-w", `${dragSide.width}px`);
    }
    if (dragRail !== undefined) el.style.setProperty("--ev-rail-w", `${dragRail}px`);
    el.style.removeProperty("grid-template-columns");
    sashNode("side")?.style.removeProperty("--ev-side-col");
    sashNode("rail")?.style.removeProperty("--ev-rail-w");
  }
  if (dragSide !== undefined && !dragSide.collapsed) {
    sideW.value = dragSide.width;
    persist(SIDE_W_KEY, dragSide.width);
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
  if (dragSide.collapsed !== props.sideCollapsed) emit("collapse-side", dragSide.collapsed);
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
  // Out of the icon column any widening step opens at least to the minimum, so one ArrowRight
  // does not sit in the snap-to-collapse zone.
  if (props.sideCollapsed) {
    if (proposed > collapsedW.value) {
      emit("collapse-side", false);
      sideW.value = Math.max(proposed, sideSpec.value.min);
      persist(SIDE_W_KEY, sideW.value);
    }
    return;
  }
  // Keyboard steps commit at once; only pointer drags defer to `commitDrag`.
  const fit = fitSidebar(proposed, vpWidth.value, railColW.value, scale.value);
  if (fit.collapsed !== props.sideCollapsed) emit("collapse-side", fit.collapsed);
  if (!fit.collapsed) {
    sideW.value = fit.width;
    persist(SIDE_W_KEY, fit.width);
  }
}

function onSideReset(): void {
  emit("collapse-side", false);
  sideW.value = fitSidebar(
    sideSpec.value.default,
    vpWidth.value,
    railColW.value,
    scale.value,
  ).width;
  persist(SIDE_W_KEY, sideW.value);
}

function onRailReset(): void {
  railW.value = fitRail(railSpec.value.default, vpWidth.value, sideColW.value, scale.value);
  persist(RAIL_W_KEY, railW.value);
}

/** A stored width the viewport or interface scale no longer affords comes back into range. */
function reclamp(): void {
  const w = vpWidth.value;
  if (w <= 0) return;
  if (w > SIDE_DRAWER_PX && !props.sideCollapsed) {
    const fit = fitSidebar(sideW.value, w, railColW.value, scale.value);
    if (fit.width !== sideW.value) {
      sideW.value = fit.width;
      persist(SIDE_W_KEY, fit.width);
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

// ——— Drawer swipe: a touch drag toward the edge dismisses the open drawer ———
type DrawerDrag = {
  pointerId: number;
  which: "side" | "rail";
  el: HTMLElement;
  /** Direction toward the dismiss edge: the sidebar leaves left, the rail leaves right. */
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
  // Touch/pen pointers capture implicitly, so the moves below arrive even off the element.
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
    // Land on the drawer's own closed transform so it slides out from where the finger left it;
    // the inline styles clear once the visibility transition has hidden it.
    el.style.transform =
      which === "side"
        ? "translateX(calc(-100% - 2 * var(--ev-inset)))"
        : "translateX(calc(100% + 2 * var(--ev-inset)))";
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

// A drawer closed from elsewhere mid-drag (Escape, a breakpoint) drops the gesture state.
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
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    emit("toggle-side");
    return;
  }
  if (event.key === "Escape" && !props.modalOpen && props.drawer !== null) {
    emit("close-drawer");
  }
}

// A drawer left open while the window grows past its breakpoint would keep the rest of the page inert.
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
      ref="frame"
      class="frame"
      :class="{
        'with-rail': withRail,
        'side-collapsed': sideCollapsed,
      }"
      :style="frameStyle"
    >
      <nav
        ref="sidebar"
        class="sidebar"
        :class="{ open: drawer === 'side', collapsed: sideCollapsed }"
        :aria-label="t('Navigation')"
        :inert="drawer === 'rail'"
        @pointerdown="drawerDown('side', $event)"
        @pointermove="drawerMove"
        @pointerup="drawerUp"
        @pointercancel="drawerUp"
      >
        <slot name="sidebar" />
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
        :inert="drawer === 'side'"
        @pointerdown="drawerDown('rail', $event)"
        @pointermove="drawerMove"
        @pointerup="drawerUp"
        @pointercancel="drawerUp"
      >
        <slot name="rail" />
      </aside>
      <Sash
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
        v-if="withRail"
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
