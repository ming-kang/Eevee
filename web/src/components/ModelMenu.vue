<script setup lang="ts">
import type { ModelSpecView } from "@shared/api/contract.ts";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { t } from "../i18n.ts";
import { listStep } from "../keyboard.ts";
import { groupModels, sameModel } from "../model-choice.ts";
import Icon from "./Icon.vue";

/** The model list behind a picker: search on top, models by name under their provider, arrows and Enter to choose. */
const props = defineProps<{
  models: readonly ModelSpecView[];
  selected?: { provider: string; modelId: string };
  /** When set, a first row drops the choice; this is the model it falls back to. */
  fallback?: string;
}>();

const emit = defineEmits<{
  pick: [spec: ModelSpecView | null];
  close: [];
}>();

const query = ref("");
const input = ref<HTMLInputElement>();
const list = ref<HTMLElement>();
const groups = computed(() => groupModels(props.models, query.value));
const showFallback = computed(() => props.fallback !== undefined && query.value.trim() === "");
const rows = computed<(ModelSpecView | null)[]>(() => [
  ...(showFallback.value ? [null] : []),
  ...groups.value.flatMap(([, specs]) => specs),
]);
const active = ref(0);

watch(query, () => {
  active.value = 0;
});

onMounted(() => {
  const at = rows.value.findIndex((row) =>
    row === null ? props.selected === undefined : sameModel(row, props.selected),
  );
  active.value = Math.max(0, at);
  input.value?.focus();
  void reveal();
});

async function reveal(): Promise<void> {
  await nextTick();
  list.value?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

function onKeydown(event: KeyboardEvent): void {
  // Left leaves a submenu only while there is no query to move through.
  if (event.key === "Escape" || (event.key === "ArrowLeft" && query.value === "")) {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const row = rows.value[active.value];
    if (row !== undefined) emit("pick", row);
    return;
  }
  const next = listStep(event.key, active.value, rows.value.length);
  if (next === undefined) return;
  event.preventDefault();
  active.value = next;
  void reveal();
}
</script>

<template>
  <div class="pop model-pop">
    <div class="pop-search">
      <Icon name="search" size="sm" />
      <input
        ref="input"
        v-model="query"
        :placeholder="t('Search models')"
        :aria-label="t('Search models')"
        role="combobox"
        aria-expanded="true"
        :aria-activedescendant="`model-row-${active}`"
        @keydown="onKeydown"
      />
    </div>
    <div ref="list" class="pop-list" role="listbox" :aria-label="t('Models')">
      <button
        v-if="showFallback"
        id="model-row-0"
        type="button"
        class="pop-row"
        :class="{ sel: active === 0 }"
        role="option"
        :aria-selected="selected === undefined"
        tabindex="-1"
        @mouseenter="active = 0"
        @click="emit('pick', null)"
      >
        <span class="spacer">{{ t("Default") }}</span>
        <span class="meta">{{ fallback }}</span>
        <Icon v-if="selected === undefined" name="check" size="sm" />
      </button>
      <template v-for="[provider, specs] in groups" :key="provider">
        <div class="palette-g">{{ provider }}</div>
        <button
          v-for="spec in specs"
          :id="`model-row-${rows.indexOf(spec)}`"
          :key="`${spec.provider}/${spec.modelId}`"
          type="button"
          class="pop-row"
          :class="{ sel: rows.indexOf(spec) === active }"
          role="option"
          :aria-selected="sameModel(spec, selected)"
          tabindex="-1"
          :title="`${spec.provider}/${spec.modelId}`"
          @mouseenter="active = rows.indexOf(spec)"
          @click="emit('pick', spec)"
        >
          <span class="spacer ellipsis">{{ spec.name }}</span>
          <Icon v-if="sameModel(spec, selected)" name="check" size="sm" />
        </button>
      </template>
      <div v-if="rows.length === 0" class="palette-empty">{{ t("No models match") }}</div>
    </div>
  </div>
</template>
