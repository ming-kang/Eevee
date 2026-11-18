<script setup lang="ts">
import { t } from "../i18n.ts";
import { useSubmit } from "../submit.ts";
import Icon from "./Icon.vue";

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
  <div class="failure">
    <Icon name="alert" size="sm" />
    <span>{{ t("The last turn didn't finish: {text}", { text }) }}</span>
    <span v-if="retrying.error.value" class="error">{{ retrying.error.value }}</span>
    <span class="spacer" />
    <button
      v-if="retry"
      type="button"
      class="btn sm"
      :disabled="retrying.busy.value"
      @click="onRetry"
    >
      {{ t("Retry") }}
    </button>
  </div>
</template>
