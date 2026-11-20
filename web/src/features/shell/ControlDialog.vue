<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { BoardView, EngineStatus, ProjectSummary } from "@shared/protocol/contract.ts";
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { ref } from "vue";
import type { IconName } from "../../composables/icons.ts";
import { useFocusReturn } from "../../composables/focus.ts";
import { t } from "../../lib/i18n.ts";
import { type ControlSection, formatRoute, type Route } from "../../lib/router.ts";
import type { StreamState } from "../../lib/stream.ts";
import Button from "../../ui/Button.vue";
import Icon from "../../ui/Icon.vue";
import MemoryPage from "../memory/MemoryPage.vue";
import SettingsPage from "../settings/SettingsPage.vue";
import UsagePage from "../usage/UsagePage.vue";

const props = defineProps<{
  open: boolean;
  section: ControlSection;
  item?: string;
  project?: ProjectSummary;
  board?: BoardView;
  client: Client;
  status: EngineStatus | undefined;
  streamState: StreamState;
  refreshStatus: () => Promise<void>;
}>();
const emit = defineEmits<{ close: []; navigate: [route: Route]; "open-ticket": [tid: string] }>();

const content = ref<InstanceType<typeof DialogContent>>();
useFocusReturn(() => props.open, () => content.value?.$el);

const sections: { key: ControlSection; label: string; icon: IconName }[] = [
  { key: "memory", label: t("Memory"), icon: "book" },
  { key: "usage", label: t("Usage"), icon: "chart" },
  { key: "general", label: t("General"), icon: "sliders" },
  { key: "models", label: t("Models"), icon: "cpu" },
  { key: "roles", label: t("Roles"), icon: "puzzle" },
  { key: "mcp", label: t("MCP & extensions"), icon: "plug" },
  { key: "engine", label: "Engine", icon: "server" },
];

function sectionRoute(section: ControlSection): Route {
  return { name: "control", section, ...(props.project ? { pid: props.project.id } : {}) };
}
</script>

<template>
  <DialogRoot :open="open" @update:open="(next) => next || emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-overlay" />
      <DialogContent
        ref="content"
        :aria-describedby="undefined"
        class="control-dialog fixed top-1/2 left-1/2 z-50 flex h-[min(720px,calc(100dvh-64px))] w-[min(920px,calc(100vw-64px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-panel border-0 bg-surface text-fg shadow-prominent max-sm:h-dvh max-sm:w-screen max-sm:rounded-none max-sm:border-0"
        @close-auto-focus="(event) => event.preventDefault()"
      >
        <header class="flex h-13 shrink-0 items-center gap-3 border-b border-separator px-4">
          <DialogTitle class="text-lg font-medium">{{ t("Control") }}</DialogTitle>
          <span class="spacer" />
          <span v-if="project && (section === 'memory' || section === 'usage')" class="truncate text-sm text-fg-muted">{{ project.title }}</span>
          <Button variant="ghost" size="sm" icon :aria-label="t('Close')" @click="emit('close')">
            <Icon name="x" size="sm" />
          </Button>
        </header>
        <div class="flex min-h-0 flex-1 max-sm:flex-col">
          <nav class="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-separator bg-sidebar p-2.5 max-sm:w-full max-sm:flex-row max-sm:overflow-x-auto max-sm:border-r-0 max-sm:border-b" :aria-label="t('Control sections')">
            <a
              v-for="entry in sections"
              :key="entry.key"
              :href="formatRoute(sectionRoute(entry.key))"
              :aria-current="section === entry.key ? 'page' : undefined"
              class="flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm transition-colors hover:bg-hover"
              :class="section === entry.key ? 'bg-selected font-medium text-fg' : 'text-fg-muted'"
              @click.prevent="emit('navigate', sectionRoute(entry.key))"
            >
              <Icon :name="entry.icon" size="sm" />
              <span>{{ entry.label }}</span>
              <span v-if="entry.key === 'memory' && board?.openProposals.length" class="count user ml-auto">{{ board.openProposals.length }}</span>
            </a>
          </nav>
          <div class="@container/vp flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <template v-if="section === 'memory' || section === 'usage'">
              <MemoryPage v-if="section === 'memory' && project" :key="project.id" :client="client" :project="project" :board="board" />
              <UsagePage v-else-if="project" :key="project.id" :client="client" :project="project" @open-ticket="emit('open-ticket', $event)" />
              <div v-else class="empty"><h3>{{ t("No projects yet") }}</h3></div>
            </template>
            <SettingsPage v-else :client="client" :section="section" :item="item" :status="status" :stream-state="streamState" :refresh-status="refreshStatus" />
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
