<script setup lang="ts">
import { t } from "../i18n.ts";
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
      :title="controlTitle ? `${t('Memory')} · ${controlTitle}` : t('Memory')"
      :aria-label="t('Memory')"
      @click="$emit('navigate')"
    >
      <Icon name="book" />
    </component>
    <component
      :is="controlPid ? 'a' : 'span'"
      class="foot-tile"
      :class="{ on: routeName === 'usage', dim: !controlPid }"
      :href="controlPid ? formatRoute({ name: 'usage', pid: controlPid }) : undefined"
      :title="controlTitle ? `${t('Usage')} · ${controlTitle}` : t('Usage')"
      :aria-label="t('Usage')"
      @click="$emit('navigate')"
    >
      <Icon name="chart" />
    </component>
    <a
      class="foot-tile"
      :class="{ on: routeName === 'settings' }"
      :href="formatRoute({ name: 'settings', section: 'general' })"
      :title="t('Settings')"
      :aria-label="t('Settings')"
      @click="$emit('navigate')"
    >
      <Icon name="sliders" />
    </a>
  </div>
</template>
