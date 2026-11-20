<script setup lang="ts">
import { t } from "../../lib/i18n.ts";
import { showToast } from "../../composables/toasts.ts";
import BrandLogo from "../../ui/BrandLogo.vue";
import Icon from "../../ui/Icon.vue";
import Button from "../../ui/Button.vue";
import { banner, CODELINE } from "../../ui/surface.ts";

defineProps<{
  reason?: string;
  networkError?: string;
}>();

defineEmits<{
  retry: [];
}>();

const COMMAND = "eevee";

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
    showToast(t("Copied {text}", { text }));
  } catch {
    showToast(t("Couldn't copy; copy it by hand"), "error");
  }
}
</script>

<template>
  <div class="grid h-full place-items-center bg-(--ev-region) p-6">
    <div class="flex w-[min(calc(400px*var(--ev-scale)),100%)] animate-[ev-pop_var(--ev-slow)_var(--ev-ease)] flex-col gap-4.5 rounded-lg border border-border bg-surface p-7 shadow-(--ev-shadow-modal)">
      <span class="flex items-center [&_svg]:size-7"><BrandLogo /></span>
      <h1 class="text-(length:--ev-title) font-semibold tracking-[-0.02em]">{{ t("Connect to the Engine") }}</h1>
      <div v-if="networkError" :class="banner('danger')" role="alert">
        <Icon name="alert" size="sm" />
        <div>{{ networkError }}</div>
      </div>
      <div v-else-if="reason" :class="banner()">
        <Icon name="lock" size="sm" />
        <div>{{ reason }}</div>
      </div>
      <div class="flex flex-col gap-2">
        <div :class="CODELINE">
          <code>{{ COMMAND }}</code>
          <Button variant="ghost" size="sm" icon :aria-label="t('Copy {command}', { command: COMMAND })" @click="copy(COMMAND)">
            <Icon name="copy" size="xs" />
          </Button>
        </div>
      </div>
      <Button v-if="networkError" @click="$emit('retry')">
        <Icon name="refresh" size="sm" />
        <span>{{ t("Retry") }}</span>
      </Button>
    </div>
  </div>
</template>
