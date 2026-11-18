<script setup lang="ts">
import { t } from "../i18n.ts";
import Icon from "./Icon.vue";

defineProps<{ count: number }>();
defineEmits<{ expand: [] }>();
</script>

<template>
  <button type="button" class="qstrip" @click="$emit('expand')">
    <span class="dot user" />
    <span>{{ t("{n} 个问题等你回答", { n: count }) }}</span>
    <span class="spacer" />
    <Icon name="chevU" size="sm" />
  </button>
</template>
