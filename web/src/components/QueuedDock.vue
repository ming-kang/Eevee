<script setup lang="ts">
import { ref } from "vue";
import { t } from "../i18n.ts";
import type { QueuedMessage } from "../transcript-map.ts";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    messages: readonly QueuedMessage[];
    /** Follow-up rows get "Steer now" too; only Worker conversations can steer mid-run. */
    canSteer?: boolean;
    /** Rows with an action in flight, by submission id. */
    busy?: ReadonlySet<string>;
  }>(),
  {
    canSteer: false,
    busy: undefined,
  },
);

const emit = defineEmits<{
  edit: [message: QueuedMessage];
  withdraw: [message: QueuedMessage];
  steer: [message: QueuedMessage];
}>();

const expanded = ref(new Set<string>());

function toggleExpanded(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function rowBusy(id: string): boolean {
  return props.busy?.has(id) === true;
}

function rowKey(event: KeyboardEvent, message: QueuedMessage): void {
  if (event.isComposing || event.target !== event.currentTarget || rowBusy(message.id)) return;
  if (event.key === "e" || event.key === "E") {
    event.preventDefault();
    emit("edit", message);
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    emit("withdraw", message);
    return;
  }
  if (
    event.key === "Enter" &&
    (event.ctrlKey || event.metaKey) &&
    props.canSteer &&
    message.mode === "followUp"
  ) {
    event.preventDefault();
    emit("steer", message);
  }
}
</script>

<template>
  <div v-if="messages.length > 0" class="qdock">
    <div
      v-for="message in messages"
      :key="message.id"
      class="qrow"
      tabindex="0"
      :aria-label="t('Queued message')"
      @keydown="rowKey($event, message)"
    >
      <span class="qmode" :class="message.mode">{{
        message.mode === "steer" ? t("Steer") : t("Queue")
      }}</span>
      <button
        type="button"
        class="qtext"
        :class="{ open: expanded.has(message.id) }"
        @click="toggleExpanded(message.id)"
      >
        {{ message.text }}
      </button>
      <span class="spacer" />
      <button
        v-if="canSteer && message.mode === 'followUp'"
        type="button"
        class="btn ghost sm"
        :disabled="rowBusy(message.id)"
        :title="t('Send it now, steering this turn')"
        @click="emit('steer', message)"
      >
        {{ t("Steer now") }}
      </button>
      <button
        type="button"
        class="btn ghost sm"
        :disabled="rowBusy(message.id)"
        :title="t('Withdraw and put the text back in the composer (E)')"
        @click="emit('edit', message)"
      >
        {{ t("Edit") }}
      </button>
      <button
        type="button"
        class="btn ghost sm icon"
        :disabled="rowBusy(message.id)"
        :title="t('Withdraw (Delete)')"
        :aria-label="t('Withdraw')"
        @click="emit('withdraw', message)"
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
  </div>
</template>
