<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { MemoryFileEntry, ProjectSummary } from "@shared/api/contract.ts";
import type {
  MemoryChange,
  MemoryChangeDetail,
  MemoryScope,
  MemorySource,
} from "@shared/contracts/index.ts";
import { computed, onUnmounted, ref, watch } from "vue";
import { errorText } from "../errors.ts";
import { focusFirst, onRovingKeydown, trapTab, useFocusReturn } from "../focus.ts";
import { t } from "../i18n.ts";
import { vSeg } from "../dom.ts";
import { useSubmit } from "../submit.ts";
import { formatRelativeTime } from "../time.ts";
import { showToast } from "../toasts.ts";
import FileDiffs from "./FileDiffs.vue";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";

const props = defineProps<{
  client: Client;
  project: ProjectSummary;
}>();

const emit = defineEmits<{
  "open-side": [];
  "modal-change": [open: boolean];
}>();

const scope = ref<MemoryScope>("project");
const MEMORY_TABS = ["history", "files"] as const;
const tab = ref<(typeof MEMORY_TABS)[number]>("history");
const changes = ref<MemoryChange[]>([]);
const changeDetails = ref<Record<string, MemoryChangeDetail>>({});
const selected = ref<number>();
const files = ref<MemoryFileEntry[]>([]);
const fileContents = ref<Record<string, string>>({});
const selectedFile = ref<string>();
const mobileDetail = ref(false);
const loadingList = ref(false);
const loadingDiff = ref(false);
const loadingFiles = ref(false);
const loadingFile = ref(false);
const listError = ref<string>();
const diffError = ref<string>();
const filesError = ref<string>();
const fileError = ref<string>();
const confirmChange = ref<MemoryChange>();
const confirmEl = ref<HTMLElement>();
useFocusReturn(
  () => confirmChange.value !== undefined,
  () => focusFirst(confirmEl.value),
);

function onConfirmKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    confirmChange.value = undefined;
    return;
  }
  trapTab(event, confirmEl.value);
}
const undoing = useSubmit();

let requestSeq = 0;
let filesSeq = 0;

const SOURCE_META: Record<
  MemorySource["kind"],
  { icon: "moon" | "radio" | "user" | "commit"; label: string; badgeClass: string }
> = {
  dreaming: { icon: "moon", label: "Dreaming", badgeClass: "dreaming" },
  router: { icon: "radio", label: "Router", badgeClass: "" },
  user: { icon: "user", label: t("You"), badgeClass: "user" },
  system: { icon: "commit", label: "Eevee", badgeClass: "" },
};

const sourceOf = (source: MemorySource) => SOURCE_META[source.kind];
const sourceLabel = (source: MemorySource) =>
  source.ticketId === undefined
    ? sourceOf(source).label
    : `${sourceOf(source).label} ${source.ticketId}`;

const selectedChange = computed(() =>
  selected.value === undefined
    ? undefined
    : changes.value.find((c) => c.id === selected.value),
);

const selectedChangeDetail = computed(() => {
  const c = selectedChange.value;
  if (!c) return undefined;
  return changeDetails.value[`${scope.value}:${c.id}`];
});

const activeFileEntry = computed(() =>
  selectedFile.value ? files.value.find((f) => f.path === selectedFile.value) : undefined,
);

const selectedFileContent = computed(() =>
  selectedFile.value === undefined
    ? undefined
    : fileContents.value[`${scope.value}:${selectedFile.value}`],
);

const selectedFileLines = computed(() => {
  const text = selectedFileContent.value;
  if (text === undefined) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

watch(
  confirmChange,
  (val) => emit("modal-change", val !== undefined),
);

onUnmounted(() => {
  emit("modal-change", false);
});

async function loadChangeDetail(targetScope: MemoryScope, id: number): Promise<void> {
  const cacheKey = `${targetScope}:${id}`;
  if (changeDetails.value[cacheKey] !== undefined) {
    diffError.value = undefined;
    return;
  }
  loadingDiff.value = true;
  diffError.value = undefined;
  try {
    const res = await props.client.call(
      "GET /api/projects/:project/memory/:scope/changes/:change",
      { project: props.project.id, scope: targetScope, change: String(id) },
    );
    changeDetails.value = { ...changeDetails.value, [cacheKey]: res };
  } catch (err) {
    diffError.value = errorText(err);
  } finally {
    loadingDiff.value = false;
  }
}

async function loadScope(preferredSelection?: number): Promise<void> {
  const token = ++requestSeq;
  const targetScope = scope.value;
  loadingList.value = true;
  listError.value = undefined;
  diffError.value = undefined;
  try {
    const res = await props.client.call("GET /api/projects/:project/memory/:scope/changes", {
      project: props.project.id,
      scope: targetScope,
    });
    if (token !== requestSeq) return;
    changes.value = res.changes;

    let nextSel = preferredSelection;
    if (nextSel === undefined || !res.changes.some((c) => c.id === nextSel)) {
      nextSel = res.changes[0]?.id;
    }
    selected.value = nextSel;
    if (nextSel !== undefined) {
      await loadChangeDetail(targetScope, nextSel);
    }
  } catch (err) {
    if (token !== requestSeq) return;
    listError.value = errorText(err);
    changes.value = [];
    selected.value = undefined;
  } finally {
    if (token === requestSeq) loadingList.value = false;
  }
}

async function loadFileContent(targetScope: MemoryScope, filePath: string): Promise<void> {
  const cacheKey = `${targetScope}:${filePath}`;
  if (fileContents.value[cacheKey] !== undefined) {
    fileError.value = undefined;
    return;
  }
  loadingFile.value = true;
  fileError.value = undefined;
  try {
    const res = await props.client.call("GET /api/projects/:project/memory/:scope/files/:file", {
      project: props.project.id,
      scope: targetScope,
      file: filePath,
    });
    fileContents.value = { ...fileContents.value, [cacheKey]: res.content };
  } catch (err) {
    fileError.value = errorText(err);
  } finally {
    loadingFile.value = false;
  }
}

async function loadFiles(preferredFile?: string): Promise<void> {
  const token = ++filesSeq;
  const targetScope = scope.value;
  loadingFiles.value = true;
  filesError.value = undefined;
  fileError.value = undefined;
  try {
    const res = await props.client.call("GET /api/projects/:project/memory/:scope/files", {
      project: props.project.id,
      scope: targetScope,
    });
    if (token !== filesSeq) return;
    files.value = res.files;
    const nextFile =
      preferredFile && res.files.some((f) => f.path === preferredFile)
        ? preferredFile
        : res.files[0]?.path;
    selectedFile.value = nextFile;
    if (nextFile !== undefined) {
      await loadFileContent(targetScope, nextFile);
    }
  } catch (err) {
    if (token !== filesSeq) return;
    filesError.value = errorText(err);
    files.value = [];
    selectedFile.value = undefined;
  } finally {
    if (token === filesSeq) loadingFiles.value = false;
  }
}

watch(
  [() => props.project.id, scope],
  () => {
    mobileDetail.value = false;
    selected.value = undefined;
    selectedFile.value = undefined;
    fileContents.value = {};
    void loadScope();
    if (tab.value === "files") {
      void loadFiles();
    } else {
      files.value = [];
    }
  },
  { immediate: true },
);

watch(tab, (next) => {
  mobileDetail.value = false;
  if (next === "files" && files.value.length === 0 && !loadingFiles.value) {
    void loadFiles();
  }
});

async function selectItem(id: number): Promise<void> {
  selected.value = id;
  mobileDetail.value = true;
  await loadChangeDetail(scope.value, id);
}

async function selectFile(filePath: string): Promise<void> {
  selectedFile.value = filePath;
  mobileDetail.value = true;
  await loadFileContent(scope.value, filePath);
}

function formatCommitAt(iso: string): { relative: string; title: string } {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { relative: iso, title: iso };
  return {
    relative: formatRelativeTime(ms),
    title: new Date(ms).toLocaleString(),
  };
}

function canUndo(change: MemoryChange): boolean {
  return change.id !== 1;
}

async function performUndo(): Promise<void> {
  const target = confirmChange.value;
  if (!target) return;
  const ok = await undoing.run(async () => {
    await props.client.call(
      "POST /api/projects/:project/memory/:scope/changes/:change/undo",
      { project: props.project.id, scope: scope.value, change: String(target.id) },
    );
  });
  if (ok) {
    confirmChange.value = undefined;
    changeDetails.value = {};
    fileContents.value = {};
    showToast(t("Undone change #{change}", { change: target.id }));
    await loadScope();
    if (tab.value === "files") await loadFiles();
    else files.value = [];
  }
}
</script>

<template>
  <section class="page-wrap">
    <header class="header">
      <button type="button" class="btn ghost sm icon menu-btn" :aria-label="t('Menu')" @click="$emit('open-side')">
        <Icon name="menu" size="sm" />
      </button>
      <h1>{{ t("Memory") }}</h1>
      <span class="sub ellipsis hide-sm">{{ project.title }}</span>
    </header>
    <div class="split" :class="{ 'has-detail': mobileDetail }">
      <div class="split-list">
        <div class="list-head">
          <div v-seg class="seg sm stretch" role="group" :aria-label="t('Memory scope')">
            <button
              type="button"
              :class="{ on: scope === 'project' }"
              :aria-pressed="scope === 'project'"
              @click="scope = 'project'"
            >
              {{ t("This project") }}
            </button>
            <button
              type="button"
              :class="{ on: scope === 'global' }"
              :aria-pressed="scope === 'global'"
              @click="scope = 'global'"
            >
              {{ t("Global") }}
            </button>
          </div>
          <div
            v-seg
            class="seg sm stretch"
            role="tablist"
            :aria-label="t('Memory view')"
            @keydown="onRovingKeydown($event, MEMORY_TABS, tab, (key) => (tab = key))"
          >
            <button
              type="button"
              role="tab"
              :aria-selected="tab === 'history'"
              :tabindex="tab === 'history' ? 0 : -1"
              :class="{ on: tab === 'history' }"
              @click="tab = 'history'"
            >
              {{ t("History") }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="tab === 'files'"
              :tabindex="tab === 'files' ? 0 : -1"
              :class="{ on: tab === 'files' }"
              @click="tab = 'files'"
            >
              {{ t("Files") }}
            </button>
          </div>
        </div>

        <template v-if="tab === 'history'">
          <p v-if="listError" class="error hint">{{ listError }}</p>
          <Skeleton v-else-if="loadingList && changes.length === 0" />
          <div v-else class="list">
            <button
              v-for="change in changes"
              :key="change.id"
              type="button"
              class="commit"
              :class="{ on: selected === change.id }"
              @click="selectItem(change.id)"
            >
              <span class="who" :class="sourceOf(change.source).badgeClass">
                <Icon :name="sourceOf(change.source).icon" size="xs" />
              </span>
              <span class="subj ellipsis">{{ change.summary }}</span>
              <span class="meta">
                <span>{{ sourceLabel(change.source) }}</span>
                <span>·</span>
                <span :title="formatCommitAt(change.at).title">{{ formatCommitAt(change.at).relative }}</span>
                <span>·</span>
                <span class="mono">#{{ change.id }}</span>
              </span>
            </button>
            <p v-if="changes.length === 0" class="hint">{{ t("No history") }}</p>
          </div>
        </template>
        <template v-else>
          <p v-if="filesError" class="error hint">{{ filesError }}</p>
          <Skeleton v-else-if="loadingFiles && files.length === 0" />
          <div v-else class="list">
            <button
              v-for="file in files"
              :key="file.path"
              type="button"
              class="commit"
              :class="{ on: selectedFile === file.path }"
              @click="selectFile(file.path)"
            >
              <span class="who">
                <Icon :name="file.path === 'MEMORY.md' ? 'book' : 'file'" size="xs" />
              </span>
              <span class="subj ellipsis mono">{{ file.path }}</span>
              <span class="meta">{{ formatBytes(file.size) }}</span>
            </button>
            <p v-if="files.length === 0" class="hint">{{ t("No files") }}</p>
          </div>
        </template>
      </div>

      <div class="split-detail">
        <button v-if="mobileDetail" type="button" class="btn ghost sm split-back" @click="mobileDetail = false">
          <Icon name="chevL" size="xs" />
          <span>{{ t("Back") }}</span>
        </button>
        <template v-if="tab === 'files'">
          <div v-if="selectedFile" :key="`f:${selectedFile}`" class="detail-inner">
            <div class="detail-head">
              <div class="spacer">
                <h2 class="mono">{{ selectedFile }}</h2>
                <div class="detail-meta">
                  <span v-if="selectedFileContent !== undefined">{{ t("{n} line|{n} lines", { n: selectedFileLines.length }) }}</span>
                  <span v-if="activeFileEntry">{{ formatBytes(activeFileEntry.size) }}</span>
                </div>
              </div>
            </div>
            <p v-if="fileError" class="error hint">{{ fileError }}</p>
            <Skeleton v-else-if="loadingFile && selectedFileContent === undefined" :lines="6" />
            <div v-else-if="selectedFileContent !== undefined" class="card file-diff">
              <div class="diff single">
                <div v-for="(line, idx) in selectedFileLines" :key="idx" class="ln">
                  <span>{{ idx + 1 }}</span>
                  <span class="mk" />
                  <span>{{ line }}</span>
                </div>
              </div>
            </div>
          </div>
        </template>
        <template v-else>
          <div v-if="selectedChange" :key="selectedChange.id" class="detail-inner">
            <div class="detail-head">
              <div class="spacer">
                <h2>{{ selectedChange.summary }}</h2>
                <div class="detail-meta">
                  <span class="chip mono">
                    <Icon name="commit" size="xs" />
                    <span>#{{ selectedChange.id }}</span>
                  </span>
                  <span>{{ sourceLabel(selectedChange.source) }}</span>
                  <span :title="formatCommitAt(selectedChange.at).title">
                    {{ formatCommitAt(selectedChange.at).relative }}
                  </span>
                </div>
              </div>
              <button
                v-if="canUndo(selectedChange)"
                type="button"
                class="btn sm danger"
                @click="
                  undoing.error.value = undefined;
                  confirmChange = selectedChange;
                "
              >
                <Icon name="undo" size="xs" />
                <span>{{ t("Undo") }}</span>
              </button>
            </div>
            <p v-if="diffError" class="error hint">{{ diffError }}</p>
            <Skeleton v-else-if="loadingDiff" :lines="6" />
            <FileDiffs
              v-else-if="selectedChangeDetail"
              :diffs="selectedChangeDetail.files"
              :empty-text="t('No text changes')"
            />
          </div>
        </template>
      </div>
    </div>

    <div
      v-if="confirmChange"
      class="overlay"
      @click.self="confirmChange = undefined"
      @keydown="onConfirmKeydown"
    >
      <div
        ref="confirmEl"
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="undo-title"
      >
        <div class="modal-h">
          <h2 id="undo-title">{{ t("Undo this change?") }}</h2>
          <span class="spacer" />
          <button type="button" class="btn ghost sm icon" :aria-label="t('Close')" @click="confirmChange = undefined">
            <Icon name="x" size="sm" />
          </button>
        </div>
        <div class="modal-b">
          <p class="muted">
            {{ t("This adds a change that reverses change") }} <span class="mono">#{{ confirmChange.id }}</span>{{ t(", leaving the earlier history untouched.") }}
          </p>
          <div class="codeline">
            <code>{{ confirmChange.summary }}</code>
          </div>
          <p v-if="undoing.error.value" class="composer-error" role="alert">
            {{ undoing.error.value }}
          </p>
        </div>
        <div class="modal-f">
          <button type="button" class="btn" :disabled="undoing.busy.value" @click="confirmChange = undefined">
            {{ t("Cancel") }}
          </button>
          <button type="button" class="btn primary" :disabled="undoing.busy.value" @click="performUndo">
            {{ undoing.busy.value ? t("Undoing…") : t("Undo") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
