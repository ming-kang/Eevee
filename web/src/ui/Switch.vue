<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from "reka-ui";

defineProps<{ modelValue: boolean; disabled?: boolean }>();
defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <SwitchRoot
    :model-value="modelValue"
    :disabled="disabled"
    class="relative inline-flex h-4.5 w-7.5 flex-none items-center rounded-full border border-border-strong bg-surface-2 transition-[background-color,border-color,box-shadow] disabled:opacity-45 data-[state=checked]:border-transparent data-[state=checked]:bg-accent"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <SwitchThumb
      class="block size-3 translate-x-0.5 rounded-full bg-(--switch-thumb) shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-200 data-[state=checked]:translate-x-3.5"
    />
  </SwitchRoot>
</template>
