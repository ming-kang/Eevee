<script setup lang="ts">
import { ref } from "vue";
import { t } from "../../lib/i18n.ts";
import type { QueuedMessage } from "../../lib/transcript-map.ts";
import Icon from "../../ui/Icon.vue";
import Button from "../../ui/Button.vue";

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
  <div v-if="messages.length > 0" class="flex flex-col border-b border-separator first:[&>:first-child]:rounded-t-panel [&>*+*]:border-t [&>*+*]:border-separator">
    <div
      v-for="message in messages"
      :key="message.id"
      class="flex min-h-9 animate-[ev-fade_var(--ev-regular)_var(--ev-ease)] items-center gap-2 bg-[color-mix(in_oklab,var(--fg)_2.5%,transparent)] py-1 pr-2 pl-4 text-sm text-fg focus-visible:shadow-(--ring-inset) focus-visible:outline-none"
      tabindex="0"
      :aria-label="t('Queued message')"
      @keydown="rowKey($event, message)"
    >
      <span class="flex-none rounded-xs bg-[color-mix(in_oklab,var(--fg)_7%,transparent)] px-1.5 py-0.5 text-xs font-medium text-fg-muted">{{
        message.mode === "steer" ? t("Steer") : t("Queue")
      }}</span>
      <button
        type="button"
        class="min-w-0 flex-1 text-left text-sm leading-[1.45] whitespace-pre-wrap wrap-anywhere text-fg"
        :class="expanded.has(message.id) ? 'block' : 'line-clamp-2'"
        @click="toggleExpanded(message.id)"
      >
        {{ message.text }}
      </button>
      <span class="spacer" />
      <Button v-if="canSteer && message.mode === 'followUp'" variant="ghost" size="sm" :disabled="rowBusy(message.id)" :title="t('Send it now, steering this turn')" @click="emit('steer', message)">
        {{ t("Steer now") }}
      </Button>
      <Button variant="ghost" size="sm" :disabled="rowBusy(message.id)" :title="t('Withdraw and put the text back in the composer (E)')" @click="emit('edit', message)">
        {{ t("Edit") }}
      </Button>
      <Button variant="ghost" size="sm" icon :disabled="rowBusy(message.id)" :title="t('Withdraw (Delete)')" :aria-label="t('Withdraw')" @click="emit('withdraw', message)">
        <Icon name="x" size="sm" />
      </Button>
    </div>
  </div>
</template>
