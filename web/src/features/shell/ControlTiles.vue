<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../lib/i18n.ts";
import { formatRoute, type Route } from "../../lib/router.ts";
import { useTheme } from "../../composables/theme.ts";
import Icon from "../../ui/Icon.vue";

const props = defineProps<{
  controlPid?: string;
  controlTitle?: string;
  pendingProposals?: number;
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
  <div class="flex flex-none items-center gap-1.5 border-t border-separator px-2.5 py-2">
    <a
      v-if="inUtilityPage"
      class="inline-flex h-(--ev-h-sm) items-center gap-1.25 rounded-sm px-2.25 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      :href="backHref"
      :title="t('Back to workspace')"
      @click="$emit('navigate')"
    >
      <Icon name="arrowL" size="xs" />
      <span>{{ t("Back") }}</span>
    </a>
    <span v-else class="spacer" />

    <div class="inline-flex items-center gap-0.5">
      <component
        :is="controlPid ? 'a' : 'span'"
        class="relative inline-grid size-(--ev-h-sm) place-items-center rounded-sm transition-[background-color,color,box-shadow] pointer-coarse:size-9"
        :class="[routeName === 'memory' ? 'bg-selected text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg', { 'pointer-events-none opacity-40': !controlPid }]"
        :href="controlPid ? formatRoute({ name: 'memory', pid: controlPid }) : undefined"
        :title="controlTitle ? `${t('Memory')} · ${controlTitle}` : t('Memory')"
        :aria-label="t('Memory')"
        @click="$emit('navigate')"
      >
        <Icon name="book" size="sm" />
        <span v-if="pendingProposals" class="count user absolute -right-1 -top-1">{{ pendingProposals }}</span>
      </component>
      <component
        :is="controlPid ? 'a' : 'span'"
        class="inline-grid size-(--ev-h-sm) place-items-center rounded-sm transition-[background-color,color,box-shadow] pointer-coarse:size-9"
        :class="[routeName === 'usage' ? 'bg-selected text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg', { 'pointer-events-none opacity-40': !controlPid }]"
        :href="controlPid ? formatRoute({ name: 'usage', pid: controlPid }) : undefined"
        :title="controlTitle ? `${t('Usage')} · ${controlTitle}` : t('Usage')"
        :aria-label="t('Usage')"
        @click="$emit('navigate')"
      >
        <Icon name="chart" size="sm" />
      </component>
      <button
        type="button"
        class="inline-grid size-(--ev-h-sm) place-items-center rounded-sm transition-[background-color,color,box-shadow] pointer-coarse:size-9 text-fg-muted hover:bg-hover hover:text-fg"
        :title="t('Toggle light / dark')"
        :aria-label="t('Toggle light / dark')"
        @click="toggleTheme()"
      >
        <Icon :name="resolved === 'dark' ? 'sun' : 'moon'" size="sm" />
      </button>
      <a
        class="inline-grid size-(--ev-h-sm) place-items-center rounded-sm transition-[background-color,color,box-shadow] pointer-coarse:size-9"
        :class="routeName === 'settings' ? 'bg-selected text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'"
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
