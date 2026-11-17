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
    <a
      v-if="controlPid"
      class="foot-tile"
      :class="{ on: routeName === 'memory' }"
      :href="formatRoute({ name: 'memory', pid: controlPid })"
      :title="controlTitle ? `记忆（${controlTitle}）` : '记忆'"
      @click="$emit('navigate')"
    >
      <Icon name="book" size="sm" />
      <span>记忆</span>
    </a>
    <span v-else class="foot-tile dim" title="记忆（请先创建项目）">
      <Icon name="book" size="sm" />
      <span>记忆</span>
    </span>

    <a
      v-if="controlPid"
      class="foot-tile"
      :class="{ on: routeName === 'usage' }"
      :href="formatRoute({ name: 'usage', pid: controlPid })"
      :title="controlTitle ? `花费（${controlTitle}）` : '花费'"
      @click="$emit('navigate')"
    >
      <Icon name="chart" size="sm" />
      <span>花费</span>
    </a>
    <span v-else class="foot-tile dim" title="花费（请先创建项目）">
      <Icon name="chart" size="sm" />
      <span>花费</span>
    </span>

    <a
      class="foot-tile"
      :class="{ on: routeName === 'settings' }"
      :href="formatRoute({ name: 'settings', section: 'models' })"
      title="设置"
      @click="$emit('navigate')"
    >
      <Icon name="sliders" size="sm" />
      <span>设置</span>
    </a>
  </div>
</template>
