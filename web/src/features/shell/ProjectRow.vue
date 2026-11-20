<script setup lang="ts">
import type { ProjectSummary } from "@shared/protocol/contract.ts";
import { computed } from "vue";
import { t } from "../../lib/i18n.ts";
import type { ProjectRowState } from "../../lib/projects.ts";
import StageGlyph from "../project/StageGlyph.vue";

const props = defineProps<{
  project: ProjectSummary;
  state: ProjectRowState;
  active: boolean;
  href: string;
}>();

const statusLabel = computed(() => {
  if (props.state.kind === "user") {
    return t("Pending");
  }
  if (props.state.kind === "bad") return props.state.routerFailed ?? t("Blocked");
  if (props.state.kind === "unread") return t("{n} unread completion|{n} unread completions", { n: props.state.unreadCount });
  return props.state.kind === "run" ? t("Working") : t("Idle");
});

defineEmits<{
  select: [];
  "hover-enter": [el: HTMLElement];
  "hover-leave": [event: MouseEvent];
}>();
</script>

<template>
  <a
    class="flex min-h-8 items-center gap-2.25 rounded-sm px-2 text-sm tracking-(--ev-tracking) text-fg transition-colors focus-visible:shadow-(--ring-inset) pointer-coarse:min-h-9.5"
    :class="active ? 'bg-selected font-medium [--ev-glyph-cut:var(--selected)]' : 'hover:bg-hover'"
    :href="href"
    :aria-label="`${project.title} · ${statusLabel}`"
    :aria-current="active ? 'page' : undefined"
    :title="project.title"
    @click="$emit('select')"
    @mouseenter="$emit('hover-enter', $event.currentTarget as HTMLElement)"
    @mouseleave="$emit('hover-leave', $event)"
  >
    <span class="grid w-5 shrink-0 place-items-center [&_.glyph]:size-3.5" :title="statusLabel" aria-hidden="true">
      <StageGlyph :stage="state.kind === 'user' ? 'answer' : state.kind === 'bad' ? 'blocked' : state.kind === 'unread' ? 'done' : state.kind === 'run' ? 'working' : 'idle'" />
    </span>
    <span class="min-w-0 flex-1 truncate">{{ project.title }}</span>
  </a>
</template>
