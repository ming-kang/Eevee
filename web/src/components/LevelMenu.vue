<script setup lang="ts">
import type { ThinkingLevel } from "@shared/contracts/index.ts";
import { onMounted, ref } from "vue";
import { t } from "../i18n.ts";
import { listStep } from "../keyboard.ts";
import { levelLabel } from "../model-choice.ts";
import Icon from "./Icon.vue";

/** The thinking levels a model takes, least to most; arrows and Enter to choose. */
const props = defineProps<{
  levels: readonly ThinkingLevel[];
  selected: ThinkingLevel;
}>();

const emit = defineEmits<{
  pick: [level: ThinkingLevel];
  close: [];
}>();

const list = ref<HTMLElement>();
const active = ref(Math.max(0, props.levels.indexOf(props.selected)));

onMounted(() => list.value?.focus());

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" || event.key === "ArrowLeft") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const level = props.levels[active.value];
    if (level !== undefined) emit("pick", level);
    return;
  }
  const next = listStep(event.key, active.value, props.levels.length);
  if (next === undefined) return;
  event.preventDefault();
  active.value = next;
}
</script>

<template>
  <div
    ref="list"
    class="pop level-pop"
    role="listbox"
    :aria-label="t('思考档位')"
    tabindex="-1"
    :aria-activedescendant="`level-row-${active}`"
    @keydown="onKeydown"
  >
    <button
      v-for="(level, index) in levels"
      :id="`level-row-${index}`"
      :key="level"
      type="button"
      class="pop-row"
      :class="{ sel: index === active }"
      role="option"
      :aria-selected="level === selected"
      tabindex="-1"
      @mouseenter="active = index"
      @click="emit('pick', level)"
    >
      <span class="spacer">{{ levelLabel(level) }}</span>
      <Icon v-if="level === selected" name="check" size="sm" />
    </button>
  </div>
</template>
