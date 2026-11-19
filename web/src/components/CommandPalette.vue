<script setup lang="ts">
import { computed, nextTick, onBeforeUpdate, ref, watch } from "vue";
import { trapTab, useFocusReturn } from "../focus.ts";
import { t } from "../i18n.ts";
import { listStep } from "../keyboard.ts";
import { filterPaletteItems, type PaletteItem } from "../projects.ts";
import Icon from "./Icon.vue";
import ProjectDot from "./ProjectDot.vue";
import StageGlyph from "./StageGlyph.vue";

const props = defineProps<{
  open: boolean;
  items: readonly PaletteItem[];
}>();

const emit = defineEmits<{
  close: [];
  select: [item: PaletteItem];
}>();

const query = ref("");
const selected = ref(0);
const inputEl = ref<HTMLInputElement>();
const dialogEl = ref<HTMLElement>();
const rowEls = ref<HTMLButtonElement[]>([]);

onBeforeUpdate(() => {
  rowEls.value = [];
});

const filtered = computed(() => filterPaletteItems(props.items, query.value));

useFocusReturn(
  () => props.open,
  () => {
    inputEl.value?.focus();
    return dialogEl.value;
  },
);

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    query.value = "";
    selected.value = 0;
  },
);

watch(
  () => filtered.value.length,
  (len) => {
    if (selected.value >= len) selected.value = Math.max(0, len - 1);
  },
);

watch(selected, async (idx) => {
  await nextTick();
  rowEls.value[idx]?.scrollIntoView({ block: "nearest" });
});

function choose(item: PaletteItem | undefined): void {
  if (!item) return;
  emit("select", item);
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  trapTab(event, dialogEl.value);
  // Home and End stay with the search field's caret.
  const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
  const next = arrow ? listStep(event.key, selected.value, filtered.value.length) : undefined;
  if (next !== undefined) {
    event.preventDefault();
    selected.value = next;
    return;
  }
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    choose(filtered.value[selected.value]);
  }
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="$emit('close')">
    <div
      ref="dialogEl"
      class="palette"
      role="dialog"
      aria-modal="true"
      :aria-label="t('Command palette')"
      @keydown="onKeydown"
    >
      <div class="palette-in">
        <Icon name="search" />
        <input
          id="palette-input"
          ref="inputEl"
          v-model="query"
          :placeholder="t('Search or jump to…')"
          autocomplete="off"
          role="combobox"
          :aria-label="t('Search or jump to')"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          :aria-activedescendant="filtered.length > 0 ? `palette-opt-${selected}` : undefined"
        />
      </div>
      <div id="palette-list" class="palette-list" role="listbox" :aria-label="t('Results')">
        <template v-if="filtered.length > 0">
          <template v-for="(item, index) in filtered" :key="item.id">
            <div
              v-if="index === 0 || filtered[index - 1]?.group !== item.group"
              class="palette-g"
              role="presentation"
            >
              {{ item.group }}
            </div>
            <button
              :ref="(el) => { if (el) rowEls[index] = el as HTMLButtonElement; }"
              :id="`palette-opt-${index}`"
              type="button"
              class="pop-row"
              role="option"
              tabindex="-1"
              :aria-selected="index === selected"
              :class="{ sel: index === selected }"
              @mouseenter="selected = index"
              @click="choose(item)"
            >
              <StageGlyph v-if="item.kind === 'route' && item.stage" :stage="item.stage" />
              <ProjectDot
                v-else-if="item.kind === 'route' && item.projectId"
                :id="item.projectId"
              />
              <Icon v-else-if="item.icon" :name="item.icon" size="sm" />
              <span class="ellipsis spacer">{{ item.label }}</span>
              <span v-if="item.meta" class="meta">{{ item.meta }}</span>
            </button>
          </template>
        </template>
        <div v-else class="palette-empty">{{ t("No results") }}</div>
      </div>
    </div>
  </div>
</template>
