<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { DirEntry, DirListing } from "@shared/protocol/contract.ts";
import { computed, onUnmounted, ref, watch } from "vue";
import { pathCrumbs, splitPathQuery } from "../../lib/browse.ts";
import { errorText } from "../../lib/errors.ts";
import { t } from "../../lib/i18n.ts";
import Button from "../../ui/Button.vue";
import Dialog from "../../ui/Dialog.vue";
import Icon from "../../ui/Icon.vue";
import Input from "../../ui/Input.vue";
import { ERROR_TEXT } from "../../ui/surface.ts";

const props = defineProps<{
  open: boolean;
  client: Client;
  /** The directory to open at; the home directory when omitted. */
  start?: string;
}>();
const emit = defineEmits<{
  close: [];
  pick: [dir: string];
}>();

const listing = ref<DirListing>();
const home = ref<string>();
const pathText = ref("");
const loading = ref(false);
const failed = ref<string>();
const suggestions = ref<DirEntry[]>([]);
const highlight = ref(-1);
let pending = 0;
let suggestSeq = 0;
let suggestTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
/** The listing the current suggestions were filtered from. */
let suggestedIn: { dir: string; dirs: DirEntry[] } | undefined;

const crumbs = computed(() => pathCrumbs(listing.value?.path ?? ""));

onUnmounted(() => {
  clearTimeout(suggestTimer);
  clearTimeout(hideTimer);
});

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void init();
  },
);

// The roots view also names the home directory, the fallback start; fetching it keeps the
// first listing from flashing the drive letters before home resolves.
async function init(): Promise<void> {
  try {
    const roots = await props.client.call("GET /api/fs/browse", { query: { path: "" } });
    home.value = roots.home;
  } catch {
    // Roots stay unknown; the home shortcut simply does not render.
  }
  void browse(props.start ?? home.value ?? "");
}

// An in-flight browse that another navigation has superseded resolves to nothing.
async function browse(path: string | undefined): Promise<void> {
  const seq = ++pending;
  loading.value = true;
  failed.value = undefined;
  try {
    const next = await props.client.call("GET /api/fs/browse", { query: { path: path ?? "" } });
    if (seq !== pending) return;
    listing.value = next;
    pathText.value = next.path;
    if (next.home !== undefined) home.value = next.home;
  } catch (cause) {
    if (seq === pending) {
      failed.value = errorText(cause);
      listing.value = undefined;
    }
  } finally {
    if (seq === pending) loading.value = false;
  }
}

watch(pathText, (text) => {
  // The input echoing the listed directory is navigation, not a query.
  if (text === listing.value?.path) {
    suggestions.value = [];
    return;
  }
  clearTimeout(suggestTimer);
  if (splitPathQuery(text) === undefined) {
    suggestions.value = [];
    return;
  }
  suggestTimer = setTimeout(() => void updateSuggestions(text), 120);
});

async function updateSuggestions(text: string): Promise<void> {
  const seq = ++suggestSeq;
  const query = splitPathQuery(text);
  if (query === undefined || text === listing.value?.path) {
    suggestions.value = [];
    return;
  }
  if (suggestedIn?.dir !== query.dir) {
    try {
      const found = await props.client.call("GET /api/fs/browse", {
        query: { path: query.dir },
      });
      if (seq !== suggestSeq) return;
      suggestedIn = { dir: query.dir, dirs: found.dirs };
    } catch {
      if (seq === suggestSeq) {
        suggestedIn = undefined;
        suggestions.value = [];
      }
      return;
    }
  }
  const prefix = query.prefix.toLowerCase();
  suggestions.value = (suggestedIn?.dirs ?? [])
    .filter((dir) => prefix === "" || dir.name.toLowerCase().startsWith(prefix))
    .slice(0, 8);
  highlight.value = -1;
}

function pickSuggestion(dir: DirEntry): void {
  suggestions.value = [];
  void browse(dir.path);
}

function onPathKeydown(event: KeyboardEvent): void {
  const count = suggestions.value.length;
  if (count === 0) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlight.value = (highlight.value + 1) % count;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlight.value = (highlight.value - 1 + count) % count;
  } else if (event.key === "Enter" && highlight.value >= 0) {
    event.preventDefault();
    pickSuggestion(suggestions.value[highlight.value] as DirEntry);
  } else if (event.key === "Escape") {
    suggestions.value = [];
  }
}

function hideSuggestions(): void {
  // The click on a suggestion row lands after the input's blur; give it a moment.
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    suggestions.value = [];
  }, 120);
}

function choose(): void {
  const dir = listing.value?.path;
  if (!dir) return;
  emit("pick", dir);
  emit("close");
}
</script>

<template>
  <Dialog :open="open" :title="t('Choose a directory')" @close="emit('close')">
    <div class="relative">
      <form class="flex items-center gap-2" @submit.prevent="browse(pathText)">
        <Input
          v-model="pathText"
          mono
          size="sm"
          class="min-w-0 flex-1"
          :disabled="loading"
          @keydown="onPathKeydown"
          @blur="hideSuggestions"
        />
        <Button type="submit" size="sm" :disabled="loading">{{ t("Go") }}</Button>
      </form>
      <div
        v-if="suggestions.length > 0"
        role="listbox"
        class="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-surface shadow-prominent"
      >
        <button
          v-for="(dir, index) in suggestions"
          :key="dir.path"
          type="button"
          role="option"
          :aria-selected="index === highlight"
          class="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-hover"
          :class="{ 'bg-hover': index === highlight }"
          @mousedown.prevent="pickSuggestion(dir)"
        >
          <Icon name="folder" size="sm" class="shrink-0 text-fg-subtle" />
          <span class="mono truncate">{{ dir.name }}</span>
        </button>
      </div>
    </div>
    <div class="flex min-w-0 items-center gap-0.5 overflow-x-auto text-sm">
      <button
        type="button"
        class="shrink-0 rounded px-1 py-0.5 text-fg-subtle hover:bg-hover hover:text-fg"
        :title="t('Locations')"
        @click="browse('')"
      >
        <Icon name="layers" size="sm" />
      </button>
      <button
        v-if="home !== undefined"
        type="button"
        class="shrink-0 rounded px-1 py-0.5 text-fg-subtle hover:bg-hover hover:text-fg"
        :title="t('Home')"
        @click="browse(home)"
      >
        <Icon name="home" size="sm" />
      </button>
      <template v-for="(crumb, index) in crumbs" :key="crumb.path">
        <Icon v-if="index > 0" name="chevR" size="sm" class="shrink-0 text-fg-subtle" />
        <button
          type="button"
          class="mono shrink-0 rounded px-1 py-0.5 hover:bg-hover"
          :class="index === crumbs.length - 1 ? 'text-fg' : 'text-fg-muted'"
          @click="browse(crumb.path)"
        >
          {{ crumb.label }}
        </button>
      </template>
    </div>
    <div class="flex max-h-72 min-h-40 flex-col overflow-y-auto rounded-md border border-border">
      <p
        v-if="!loading && listing !== undefined && listing.dirs.length === 0"
        class="px-3 py-5 text-center text-sm text-fg-subtle"
      >
        {{ t("No subdirectories") }}
      </p>
      <button
        v-for="dir in listing?.dirs ?? []"
        :key="dir.path"
        type="button"
        class="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-hover"
        :title="dir.path"
        @click="browse(dir.path)"
      >
        <Icon name="folder" size="sm" class="shrink-0 text-fg-subtle" />
        <span class="truncate">{{ dir.name }}</span>
      </button>
      <div v-if="loading" class="flex items-center justify-center px-3 py-5">
        <Icon name="spinner" size="sm" class="animate-spin text-fg-subtle" />
      </div>
    </div>
    <p v-if="failed" :class="ERROR_TEXT" role="alert">{{ failed }}</p>
    <template #footer>
      <Button :disabled="loading" @click="emit('close')">{{ t("Cancel") }}</Button>
      <Button variant="primary" :disabled="loading || !listing?.path" @click="choose">
        {{ t("Use this directory") }}
      </Button>
    </template>
  </Dialog>
</template>
