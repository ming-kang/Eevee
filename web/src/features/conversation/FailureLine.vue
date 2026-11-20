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
  <div class="flex min-w-0 items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-3 text-sm leading-5 [&>.ico]:mt-0.5 [&>.ico]:text-danger" role="alert">
    <Icon name="alert" size="sm" />
    <span class="min-w-0 flex-1 wrap-anywhere text-fg-muted">{{ t("The last turn didn't finish: {text}", { text }) }}</span>
    <span v-if="retrying.error.value" class="error">{{ retrying.error.value }}</span>
    <Button v-if="retry" size="sm" :disabled="retrying.busy.value" @click="onRetry">
      {{ t("Retry") }}
    </Button>
  </div>
</template>
