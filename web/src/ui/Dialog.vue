<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { useFocusReturn } from "../composables/focus.ts";
import { t } from "../lib/i18n.ts";
import Button from "./Button.vue";
import Icon from "./Icon.vue";

const props = withDefaults(defineProps<{ open: boolean; title: string; as?: "div" | "form" }>(), {
  as: "div",
});
const emit = defineEmits<{ close: []; submit: []; openAutoFocus: [event: Event] }>();
useFocusReturn(
  () => props.open,
  () => undefined,
);
</script>

<template>
  <DialogRoot :open="open" @update:open="(next) => next || emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-overlay animate-[ev-fade_var(--ev-regular)_var(--ev-ease)]" />
      <div v-if="open" class="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[13vh] pb-4">
        <DialogContent
          :as="as"
          :aria-describedby="undefined"
          class="flex max-h-full w-[min(calc(460px*var(--ev-scale)),100%)] flex-col overflow-hidden rounded-panel border-0 bg-surface text-fg shadow-prominent animate-[ev-pop_var(--ev-regular)_var(--ev-ease)]"
          @submit.prevent="emit('submit')"
          @open-auto-focus="emit('openAutoFocus', $event)"
          @close-auto-focus="(event) => event.preventDefault()"
        >
          <div class="flex items-center gap-2 pt-4 pr-3 pb-1 pl-5">
            <DialogTitle class="flex-1 text-lg font-medium tracking-[-0.015em]">{{ title }}</DialogTitle>
            <Button variant="ghost" size="sm" icon :aria-label="t('Close')" @click="emit('close')">
              <Icon name="x" size="sm" />
            </Button>
          </div>
          <div class="flex flex-col gap-3.5 overflow-y-auto px-5 pt-3 pb-1 text-base leading-[1.6]">
            <slot />
          </div>
          <div v-if="$slots.footer" class="flex justify-end gap-2 px-5 pt-4 pb-5">
            <slot name="footer" />
          </div>
        </DialogContent>
      </div>
    </DialogPortal>
  </DialogRoot>
</template>
