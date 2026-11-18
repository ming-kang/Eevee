<script setup lang="ts">
import { t } from "../i18n.ts";
import { showToast } from "../toasts.ts";
import BrandLogo from "./BrandLogo.vue";
import Icon from "./Icon.vue";

defineProps<{
  reason?: string;
  networkError?: string;
}>();

defineEmits<{
  retry: [];
}>();

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
    showToast(t("已复制 {text}", { text }));
  } catch {
    showToast(t("复制失败，请手动复制"), "error");
  }
}
</script>

<template>
  <div class="connect">
    <div class="connect-card">
      <span class="brand"><BrandLogo /></span>
      <h1>{{ t("连接到 Engine") }}</h1>
      <div v-if="networkError" class="banner bad" role="alert">
        <Icon name="alert" size="sm" />
        <div>{{ networkError }}</div>
      </div>
      <div v-else-if="reason" class="banner">
        <Icon name="lock" size="sm" />
        <div>{{ reason }}</div>
      </div>
      <div class="connect-steps">
        <div v-for="command in networkError ? ['eevee start', 'eevee web'] : ['eevee web']" :key="command" class="codeline">
          <code>{{ command }}</code>
          <button
            type="button"
            class="btn ghost sm icon"
            :aria-label="t('复制 {command}', { command })"
            @click="copy(command)"
          >
            <Icon name="copy" size="xs" />
          </button>
        </div>
      </div>
      <button v-if="networkError" type="button" class="btn" @click="$emit('retry')">
        <Icon name="refresh" size="sm" />
        <span>{{ t("重试") }}</span>
      </button>
    </div>
  </div>
</template>
