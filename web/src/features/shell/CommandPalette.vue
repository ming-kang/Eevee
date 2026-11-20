<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { computed, nextTick, onBeforeUpdate, ref, watch } from "vue";
import { useFocusReturn } from "../../composables/focus.ts";
import { t } from "../../lib/i18n.ts";
import { listStep } from "../../lib/keyboard.ts";
import { filterPaletteItems, type PaletteItem } from "../../lib/projects.ts";
import Icon from "../../ui/Icon.vue";
import StageGlyph from "../project/StageGlyph.vue";
import { MENU_EMPTY, MENU_GROUP, menuRow } from "../../ui/menu.ts";

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
const rowEls = ref<HTMLButtonElement[]>([]);

onBeforeUpdate(() => {
  rowEls.value = [];
});

const filtered = computed(() => filterPaletteItems(props.items, query.value));

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

useFocusReturn(
  () => props.open,
  () => undefined,
);

function focusInput(event: Event): void {
  event.preventDefault();
  inputEl.value?.focus();
}

function onKeydown(event: KeyboardEvent): void {
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
  <DialogRoot :open="open" @update:open="(next) => next || emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-overlay backdrop-blur-[4px] animate-[ev-fade_var(--ev-regular)_var(--ev-ease)]" />
      <div v-if="open" class="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[13vh] pb-4">
    <DialogContent
      class="flex w-[min(calc(600px*var(--ev-scale)),100%)] animate-[ev-pop_var(--ev-regular)_var(--ev-ease)] flex-col overflow-hidden rounded-lg border border-border bg-(--ev-glass-bg) shadow-(--ev-shadow-modal) backdrop-blur-(--ev-glass-blur) backdrop-saturate-(--ev-glass-sat)"
      :aria-describedby="undefined"
      @keydown="onKeydown"
      @open-auto-focus="focusInput"
      @close-auto-focus="(event) => event.preventDefault()"
    >
      <DialogTitle class="sr">{{ t("Command palette") }}</DialogTitle>
      <div class="flex h-13 items-center gap-2.5 px-4.5 text-fg-subtle shadow-[inset_0_-1px_0_var(--ev-separator)] [&_input]:h-full [&_input]:min-w-0 [&_input]:flex-1 [&_input]:border-0 [&_input]:bg-transparent [&_input]:text-base [&_input]:text-fg [&_input]:focus:shadow-none [&_input]:focus-visible:shadow-none">
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
      <div id="palette-list" class="max-h-[min(56vh,calc(440px*var(--ev-scale)))] overflow-y-auto p-1.5" role="listbox" :aria-label="t('Results')">
        <template v-if="filtered.length > 0">
          <template v-for="(item, index) in filtered" :key="item.id">
            <div
       v-if="index === 0 || filtered[index - 1]?.group !== item.group"
       :class="MENU_GROUP"
       role="presentation"
>
              {{ item.group }}
            </div>
            <button
       :ref="(el) => { if (el) rowEls[index] = el as HTMLButtonElement; }"
       :id="`palette-opt-${index}`"
       type="button"
       
       role="option"
       tabindex="-1"
       :aria-selected="index === selected"
       :class="[menuRow('md'), { sel: index === selected }]"
       @mouseenter="selected = index"
       @click="choose(item)"
>
              <StageGlyph v-if="item.kind === 'route' && item.stage" :stage="item.stage" />
              <Icon v-else-if="item.icon" :name="item.icon" size="sm" />
              <span class="ellipsis spacer">{{ item.label }}</span>
              <span v-if="item.meta" class="meta">{{ item.meta }}</span>
            </button>
          </template>
        </template>
        <div v-else :class="MENU_EMPTY">{{ t("No results") }}</div>
      </div>
    </DialogContent>
      </div>
    </DialogPortal>
  </DialogRoot>
</template>
