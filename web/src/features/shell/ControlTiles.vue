<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n.ts";
import { formatRoute, type Route } from "../router.ts";
import { useTheme } from "../theme.ts";
import Icon from "./Icon.vue";

const props = defineProps<{
  controlPid?: string;
  controlTitle?: string;
  routeName: Route["name"];
}>();

defineEmits<{
  navigate: [];
}>();

const { resolved, toggleTheme } = useTheme();

const inUtilityPage = computed(
  () =>
    props.routeName === "settings" ||
    props.routeName === "memory" ||
    props.routeName === "usage",
);

const backHref = computed(() =>
  props.controlPid
    ? formatRoute({ name: "chat", pid: props.controlPid })
    : formatRoute({ name: "home" }),
);
</script>

<template>
  <div class="side-foot">
    <a
      v-if="inUtilityPage"
      class="foot-back"
      :href="backHref"
      :title="t('Back to workspace')"
      @click="$emit('navigate')"
    >
      <Icon name="arrowL" size="xs" />
      <span>{{ t("Back") }}</span>
    </a>
    <span v-else class="spacer" />

    <div class="foot-actions">
      <component
        :is="controlPid ? 'a' : 'span'"
        class="foot-tile"
        :class="{ on: routeName === 'memory', dim: !controlPid }"
        :href="controlPid ? formatRoute({ name: 'memory', pid: controlPid }) : undefined"
        :title="controlTitle ? `${t('Memory')} · ${controlTitle}` : t('Memory')"
        :aria-label="t('Memory')"
        @click="$emit('navigate')"
      >
        <Icon name="book" size="sm" />
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
        <Icon name="chart" size="sm" />
      </component>
      <button
        type="button"
        class="foot-tile"
        :title="t('Toggle light / dark')"
        :aria-label="t('Toggle light / dark')"
        @click="toggleTheme()"
      >
        <Icon :name="resolved === 'dark' ? 'sun' : 'moon'" size="sm" />
      </button>
      <a
        class="foot-tile"
        :class="{ on: routeName === 'settings' }"
        :href="formatRoute({ name: 'settings', section: 'general' })"
        :title="t('Settings')"
        :aria-label="t('Settings')"
        @click="$emit('navigate')"
      >
        <Icon name="sliders" size="sm" />
      </a>
    </div>
  </div>
</template>
