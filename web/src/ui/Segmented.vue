<script setup lang="ts" generic="K extends string">
import { computed } from "vue";
import { vSeg } from "../composables/dom.ts";
import { onRovingKeydown } from "../composables/focus.ts";

export type SegmentedOption<K extends string> = {
  value: K;
  label?: string;
  title?: string;
  lang?: string;
};

const props = withDefaults(
  defineProps<{
    options: readonly SegmentedOption<K>[];
    label: string;
    /** `toggle` is a group of pressed buttons; `tabs` is a tablist that drives a tabpanel. */
    mode?: "toggle" | "tabs";
    size?: "sm" | "md";
    stretch?: boolean;
    /** Gives each tab the id `${idPrefix}-${value}` so the panel can point back at it. */
    idPrefix?: string;
    /** The id of the tabpanel the tabs control. */
    controls?: string;
  }>(),
  { mode: "toggle", size: "sm", stretch: false, idPrefix: undefined, controls: undefined },
);
const model = defineModel<K>({ required: true });

const tabs = computed(() => props.mode === "tabs");
const keys = computed(() => props.options.map((option) => option.value));

const root = computed(() => [
  "seg relative isolate flex-none items-stretch bg-surface-2 p-0.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--border)_60%,transparent)]",
  props.stretch ? "flex w-full" : "inline-flex",
  props.size === "sm" ? "sm h-7 rounded-sm" : "h-8 rounded-md",
]);
const item = computed(() => [
  "relative z-1 inline-flex min-w-0 items-center justify-center gap-1.25 whitespace-nowrap text-sm font-medium tracking-(--ev-tracking) text-fg-muted transition-colors hover:text-fg",
  props.size === "sm" ? "rounded-[5px] px-2.25" : "rounded-sm px-3",
  props.stretch && "flex-1",
]);

function onKeydown(event: KeyboardEvent): void {
  if (tabs.value) onRovingKeydown(event, keys.value, model.value, (key) => (model.value = key));
}
</script>

<template>
  <div v-seg :class="root" :role="tabs ? 'tablist' : 'group'" :aria-label="label" @keydown="onKeydown">
    <button
      v-for="(option, index) in options"
      :id="idPrefix === undefined ? undefined : `${idPrefix}-${option.value}`"
      :key="option.value"
      type="button"
      :lang="option.lang"
      :title="option.title"
      :role="tabs ? 'tab' : undefined"
      :aria-controls="tabs ? controls : undefined"
      :aria-selected="tabs ? model === option.value : undefined"
      :aria-pressed="tabs ? undefined : model === option.value"
      :tabindex="tabs ? (model === option.value ? 0 : -1) : undefined"
      :class="[item, model === option.value && 'on text-fg']"
      @click="model = option.value"
    >
      <slot :option="option" :index="index" :selected="model === option.value">{{ option.label }}</slot>
    </button>
  </div>
</template>
