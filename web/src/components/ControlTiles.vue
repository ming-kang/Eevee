<script setup lang="ts">
import { formatRoute, type Route } from "../router.ts";
import Icon from "./Icon.vue";

defineProps<{
  controlPid?: string;
  controlTitle?: string;
  routeName: Route["name"];
}>();

defineEmits<{
  navigate: [];
}>();
</script>

<template>
  <div class="side-foot">
    <component
      :is="controlPid ? 'a' : 'span'"
      class="foot-tile"
      :class="{ on: routeName === 'memory', dim: !controlPid }"
      :href="controlPid ? formatRoute({ name: 'memory', pid: controlPid }) : undefined"
      :title="controlTitle ? `记忆 · ${controlTitle}` : '记忆'"
      aria-label="记忆"
      @click="$emit('navigate')"
    >
      <Icon name="book" />
    </component>
    <component
      :is="controlPid ? 'a' : 'span'"
      class="foot-tile"
      :class="{ on: routeName === 'usage', dim: !controlPid }"
      :href="controlPid ? formatRoute({ name: 'usage', pid: controlPid }) : undefined"
      :title="controlTitle ? `花费 · ${controlTitle}` : '花费'"
      aria-label="花费"
      @click="$emit('navigate')"
    >
      <Icon name="chart" />
    </component>
    <a
      class="foot-tile"
      :class="{ on: routeName === 'settings' }"
      :href="formatRoute({ name: 'settings', section: 'models' })"
      title="设置"
      aria-label="设置"
      @click="$emit('navigate')"
    >
      <Icon name="sliders" />
    </a>
  </div>
</template>
