<script setup lang="ts">
import { t } from "../../lib/i18n.ts";
import { useSubmit } from "../../composables/submit.ts";
import Icon from "../../ui/Icon.vue";
import Button from "../../ui/Button.vue";

const props = defineProps<{
  text: string;
  retry?: () => Promise<void>;
}>();

const retrying = useSubmit();

function onRetry(): void {
  const action = props.retry;
  if (action) void retrying.run(action);
}
</script>

<template>
  <div class="flex items-center gap-2.5 rounded-md border border-[color-mix(in_oklab,var(--danger)_28%,var(--border))] bg-[color-mix(in_oklab,var(--surface)_93%,var(--danger))] py-2 pr-2 pl-3 text-sm shadow-(--ev-shadow-card) [&>.ico]:text-danger">
    <Icon name="alert" size="sm" />
    <span>{{ t("The last turn didn't finish: {text}", { text }) }}</span>
    <span v-if="retrying.error.value" class="error">{{ retrying.error.value }}</span>
    <span class="spacer" />
    <Button v-if="retry" size="sm" :disabled="retrying.busy.value" @click="onRetry">
      {{ t("Retry") }}
    </Button>
  </div>
</template>
