<script setup lang="ts">
import { computed } from "vue";
import { ICONS, type IconName, type IconPrimitive } from "../icons.ts";

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: "xs" | "sm" | "md" | "lg";
    spin?: boolean;
  }>(),
  { size: "md", spin: false },
);

const primitives = computed<readonly IconPrimitive[]>(() => ICONS[props.name]);
const spinning = computed(() => props.spin || props.name === "spinner");
</script>

<template>
  <!-- A turning icon turns an HTML box: Chromium does not composite a transform on an <svg> at a device
       pixel ratio other than 1, so a spinning <svg> re-runs style and paint on the main thread every frame. -->
  <span v-if="spinning" class="ico spin" :class="size === 'md' ? '' : size" aria-hidden="true">
    <svg viewBox="0 0 24 24">
      <template v-for="(item, index) in primitives" :key="index">
        <path v-if="item.tag === 'path'" :d="item.d" />
        <circle v-else-if="item.tag === 'circle'" :cx="item.cx" :cy="item.cy" :r="item.r" :fill="item.fill" />
        <rect
          v-else
          :x="item.x"
          :y="item.y"
          :width="item.width"
          :height="item.height"
          :rx="item.rx"
          :fill="item.fill"
          :stroke="item.stroke"
        />
      </template>
    </svg>
  </span>
  <svg v-else class="ico" :class="size === 'md' ? '' : size" viewBox="0 0 24 24" aria-hidden="true">
    <template v-for="(item, index) in primitives" :key="index">
      <path v-if="item.tag === 'path'" :d="item.d" />
      <circle v-else-if="item.tag === 'circle'" :cx="item.cx" :cy="item.cy" :r="item.r" :fill="item.fill" />
      <rect
        v-else
        :x="item.x"
        :y="item.y"
        :width="item.width"
        :height="item.height"
        :rx="item.rx"
        :fill="item.fill"
        :stroke="item.stroke"
      />
    </template>
  </svg>
</template>
