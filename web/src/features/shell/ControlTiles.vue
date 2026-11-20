<script setup lang="ts">
import { t } from "../../lib/i18n.ts";
import { formatRoute } from "../../lib/router.ts";
import { useTheme } from "../../composables/theme.ts";
import Icon from "../../ui/Icon.vue";

defineProps<{ pendingProposals?: number }>();
defineEmits<{ navigate: [] }>();

const { resolved, toggleTheme } = useTheme();
</script>

<template>
  <div class="flex flex-none items-center gap-1.5 border-t border-separator px-2.5 py-2">
    <a
      class="flex h-(--ev-h-sm) flex-1 items-center gap-2 rounded-sm px-2 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      :href="formatRoute({ name: 'control', section: 'general' })"
      @click="$emit('navigate')"
    >
      <Icon name="sliders" size="sm" />
      <span class="spacer">{{ t("Control") }}</span>
      <span v-if="pendingProposals" class="count user">{{ pendingProposals }}</span>
    </a>
    <button
      type="button"
      class="inline-grid size-(--ev-h-sm) place-items-center rounded-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg pointer-coarse:size-9"
      :title="t('Toggle light / dark')"
      :aria-label="t('Toggle light / dark')"
      @click="toggleTheme()"
    >
      <Icon :name="resolved === 'dark' ? 'sun' : 'moon'" size="sm" />
    </button>
  </div>
</template>
