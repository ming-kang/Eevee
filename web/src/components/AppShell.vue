<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { focusFirst, useFocusReturn } from "../focus.ts";
import { t } from "../i18n.ts";

const props = defineProps<{
  withRail: boolean;
  sideCollapsed: boolean;
  drawer: "side" | "rail" | null;
  modalOpen?: boolean;
}>();

const emit = defineEmits<{
  "close-drawer": [];
  "toggle-side": [];
}>();

/** Widths at which the rail and the sidebar turn into drawers; they match the container queries in `style.css`. */
const RAIL_DRAWER = "(max-width: 1240px)";
const SIDE_DRAWER = "(max-width: 760px)";

const sidebar = ref<HTMLElement>();
const rail = ref<HTMLElement>();

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

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  for (const query of queries) query.addEventListener("change", onBreakpoint);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  for (const query of queries) query.removeEventListener("change", onBreakpoint);
});
</script>

<template>
  <div class="viewport">
    <div
      class="frame"
      :class="{
        'with-rail': withRail,
        'side-collapsed': sideCollapsed,
      }"
    >
      <nav
        ref="sidebar"
        class="sidebar"
        :class="{ open: drawer === 'side', collapsed: sideCollapsed }"
        :aria-label="t('导航')"
        :inert="drawer === 'rail'"
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
        :aria-label="t('工单与作业')"
        :inert="drawer === 'side'"
      >
        <slot name="rail" />
      </aside>
    </div>
    <div
      class="drawer-bg"
      :class="{ on: drawer !== null }"
      aria-hidden="true"
      @click="$emit('close-drawer')"
    />
    <slot name="overlay" />
  </div>
</template>
