<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { MemoryFileEntry, ProjectSummary, BoardView } from "@shared/protocol/contract.ts";
import type {
  MemoryChange,
  MemoryChangeDetail,
  MemoryScope,
  MemorySource,
} from "@shared/domain/index.ts";
import { computed, onUnmounted, ref, watch } from "vue";
import { errorText } from "../../lib/errors.ts";
import { t } from "../../lib/i18n.ts";
import { useSubmit } from "../../composables/submit.ts";
import { formatRelativeTime } from "../../lib/time.ts";
import { showToast } from "../../composables/toasts.ts";
import FileDiffs from "./FileDiffs.vue";
import MemoryEditor from "./MemoryEditor.vue";
import ProposalReview from "./ProposalReview.vue";
import { createProposalReview } from "./review.ts";
import { createMemoryEditor } from "./editor.ts";
import Icon from "../../ui/Icon.vue";
import Skeleton from "../../ui/Skeleton.vue";
import Button from "../../ui/Button.vue";
import Segmented from "../../ui/Segmented.vue";
import Dialog from "../../ui/Dialog.vue";
import { badge, CODELINE, ERROR_TEXT, PANEL } from "../../ui/surface.ts";
import { diff } from "../../ui/diff.ts";

const props = defineProps<{
  client: Client;
  project: ProjectSummary;
  board?: BoardView;
}>();

const emit = defineEmits<{
  "modal-change": [open: boolean];
}>();

const scope = ref<MemoryScope>("project");
const MEMORY_TABS = ["proposals", "history", "files"] as const;
const tab = ref<(typeof MEMORY_TABS)[number]>(props.board?.openProposals.length ? "proposals" : "history");
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
const undoing = useSubmit();
const review = createProposalReview(props.client, async () => {
  changeDetails.value = {};
  fileContents.value = {};
  await loadScope();
  files.value = [];
});
watch([() => props.project.id, () => props.board?.openProposals.map(p => p.id).join(",")], () => {
  void review.load(props.project.id);
}, { immediate: true });
const editor = createMemoryEditor(props.client, () => props.project.id, async (draft) => {
  if (draft.project !== props.project.id || draft.scope !== scope.value) return;
  fileContents.value = {};
  changeDetails.value = {};
  const next = draft.mode === "new" || draft.mode === "rename" ? draft.name : draft.file;
  await Promise.all([loadScope(), loadFiles(next)]);
});

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

watch([confirmChange, editor.draft], ([change, draft]) =>
  emit("modal-change", change !== undefined || draft !== undefined));

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
    const res = targetScope === "global"
      ? await props.client.call("GET /api/memory/changes/:change", { change: id })
      : await props.client.call("GET /api/projects/:project/memory/changes/:change", { project: props.project.id, change: id });
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
    const res = targetScope === "global"
      ? await props.client.call("GET /api/memory/changes")
      : await props.client.call("GET /api/projects/:project/memory/changes", { project: props.project.id });
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
    const res = targetScope === "global"
      ? await props.client.call("GET /api/memory/files/:file", { file: filePath })
      : await props.client.call("GET /api/projects/:project/memory/files/:file", { project: props.project.id, file: filePath });
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
    const res = targetScope === "global"
      ? await props.client.call("GET /api/memory/files")
      : await props.client.call("GET /api/projects/:project/memory/files", { project: props.project.id });
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
    editor.close();
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
  if (next === "proposals") void review.load(props.project.id);
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
    if (scope.value === "global") {
      await props.client.call("POST /api/memory/changes/:change/undo", { change: target.id });
    } else {
      await props.client.call("POST /api/projects/:project/memory/changes/:change/undo", { project: props.project.id, change: target.id });
    }
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

function commitClass(on: boolean): string {
  return [
    "grid w-full grid-cols-[calc(22px*var(--ev-scale))_minmax(0,1fr)] items-center gap-x-2.5 gap-y-0.5 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:shadow-(--ev-ring-in)",
    on ? "bg-selected" : "hover:bg-hover",
  ].join(" ");
}

function whoClass(source?: string): string {
  const tone =
    source === "user"
      ? "bg-[color-mix(in_oklab,var(--fg)_12%,transparent)] text-fg"
      : source === "pending"
        ? "text-fg-muted shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--fg)_22%,transparent)]"
        : "bg-[color-mix(in_oklab,var(--fg)_7%,transparent)] text-fg-muted";
  return `row-span-2 grid size-5.5 place-items-center rounded-full ${tone}`;
}

const COMMIT_META =
  "flex min-w-0 items-center gap-1.25 overflow-hidden text-xs whitespace-nowrap text-fg-subtle [&_.mono]:text-(length:--ev-caption)";
const MEASURE = "mx-auto w-full max-w-[calc(760px*var(--ev-scale))]";
const DETAIL_INNER =
  "flex animate-[ev-fade_var(--ev-regular)_var(--ev-ease)] flex-col gap-4 px-(--ev-gutter) pt-4.5 pb-12 @max-[54.2857em]/vp:px-4 @max-[54.2857em]/vp:pt-1 @max-[54.2857em]/vp:pb-10 [&>.hint]:mx-auto [&>.hint]:w-full [&>.hint]:max-w-[calc(760px*var(--ev-scale))]";
const DETAIL_HEAD = `flex items-start gap-3 ${MEASURE} [&_h2]:text-(length:--ev-headline) [&_h2]:font-medium [&_h2]:tracking-[-0.015em] [&_h2]:wrap-anywhere [&_h2.mono]:text-base`;
</script>

<template>
  <section class="page-wrap">
    <header class="header">
      <h1>{{ t("Memory") }}</h1>
      <span class="crumb-sep hide-sm" aria-hidden="true">/</span>
      <span class="sub ellipsis hide-sm">{{ project.title }}</span>
    </header>
    <div class="flex flex-wrap gap-2 border-b border-separator px-3 py-2">
      <Segmented v-model="tab" mode="tabs" appearance="rail" :options="MEMORY_TABS.map((value) => ({ value, label: value === 'proposals' ? t('Proposals') + (board?.openProposals.length ? ' · ' + board.openProposals.length : '') : value === 'history' ? t('History') : t('Files') }))" :label="t('Memory view')" />
      <Segmented v-if="tab !== 'proposals'" v-model="scope" appearance="rail" :options="[{ value: 'project', label: t('This project') }, { value: 'global', label: t('Global') }]" :label="t('Memory scope')" />
    </div>
    <ProposalReview v-if="tab === 'proposals'" :review="review" />
    <div v-else class="grid min-h-0 flex-1 grid-cols-[clamp(calc(250px*var(--ev-scale)),26%,calc(360px*var(--ev-scale)))_minmax(0,1fr)] @max-[54.2857em]/vp:grid-cols-1">
      <div class="flex min-h-0 flex-col overflow-y-auto border-r border-separator px-2.5 pt-2 pb-4 @max-[54.2857em]/vp:border-r-0" :class="{ '@max-[54.2857em]/vp:hidden': mobileDetail }">

        <template v-if="tab === 'history'">
          <p v-if="listError" class="error hint">{{ listError }}</p>
          <Skeleton v-else-if="loadingList && changes.length === 0" />
          <div v-else class="flex flex-col gap-px">
            <button
              v-for="change in changes"
              :key="change.id"
              type="button"
              :class="commitClass(selected === change.id)"
              @click="selectItem(change.id)"
            >
              <span :class="whoClass(sourceOf(change.source).badgeClass)">
                <Icon :name="sourceOf(change.source).icon" size="xs" />
              </span>
              <span class="ellipsis text-sm tracking-(--ev-tracking)">{{ change.summary }}</span>
              <span :class="COMMIT_META">
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
          <Button v-if="scope === 'project'" class="mb-2" size="sm" @click="editor.open('new', scope)">{{ t("New file") }}</Button>
          <p v-if="filesError" class="error hint">{{ filesError }}</p>
          <Skeleton v-else-if="loadingFiles && files.length === 0" />
          <div v-else class="flex flex-col gap-px">
            <button
              v-for="file in files"
              :key="file.path"
              type="button"
              :class="commitClass(selectedFile === file.path)"
              @click="selectFile(file.path)"
            >
              <span :class="whoClass()">
                <Icon :name="file.path === 'MEMORY.md' ? 'book' : 'file'" size="xs" />
              </span>
              <span class="ellipsis mono text-xs">{{ file.path }}</span>
              <span :class="COMMIT_META">{{ formatBytes(file.size) }}</span>
            </button>
            <p v-if="files.length === 0" class="hint">{{ t("No files") }}</p>
          </div>
        </template>
      </div>

      <div class="min-h-0 min-w-0 overflow-y-auto" :class="{ '@max-[54.2857em]/vp:hidden': !mobileDetail }">
        <Button v-if="mobileDetail" variant="ghost" size="sm" class="mb-2 ml-3 @min-[54.2857em]/vp:hidden" @click="mobileDetail = false">
          <Icon name="chevL" size="xs" />
          <span>{{ t("Back") }}</span>
        </Button>
        <template v-if="tab === 'files'">
          <div v-if="selectedFile" :key="`f:${selectedFile}`" :class="DETAIL_INNER">
            <div :class="DETAIL_HEAD">
              <div class="spacer">
                <h2 class="mono">{{ selectedFile }}</h2>
                <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                  <span v-if="selectedFileContent !== undefined">{{ t("{n} line|{n} lines", { n: selectedFileLines.length }) }}</span>
                  <span v-if="activeFileEntry">{{ formatBytes(activeFileEntry.size) }}</span>
                </div>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <Button size="sm" @click="editor.open('edit', scope, selectedFile)">{{ t("Edit") }}</Button>
                <template v-if="scope === 'project'">
                  <Button size="sm" @click="editor.open('rename', scope, selectedFile)">{{ t("Rename") }}</Button>
                  <Button size="sm" variant="danger" @click="editor.open('delete', scope, selectedFile)">{{ t("Delete") }}</Button>
                </template>
              </div>
            </div>
            <p v-if="fileError" class="error hint">{{ fileError }}</p>
            <Skeleton v-else-if="loadingFile && selectedFileContent === undefined" :lines="6" />
            <div v-else-if="selectedFileContent !== undefined" class="file-diff" :class="PANEL">
              <div :class="diff({ single: true })">
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
          <div v-if="selectedChange" :key="selectedChange.id" :class="DETAIL_INNER">
            <div :class="DETAIL_HEAD">
              <div class="spacer">
                <h2>{{ selectedChange.summary }}</h2>
                <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                  <span :class="badge({ mono: true })">
                    <Icon name="commit" size="xs" />
                    <span>#{{ selectedChange.id }}</span>
                  </span>
                  <span>{{ sourceLabel(selectedChange.source) }}</span>
                  <span :title="formatCommitAt(selectedChange.at).title">
                    {{ formatCommitAt(selectedChange.at).relative }}
                  </span>
                </div>
              </div>
              <Button v-if="canUndo(selectedChange)" variant="danger" size="sm" @click="
                  undoing.error.value = undefined;
                  confirmChange = selectedChange;
                ">
                <Icon name="undo" size="xs" />
                <span>{{ t("Undo") }}</span>
              </Button>
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

    <MemoryEditor :editor="editor" />
    <Dialog :open="confirmChange !== undefined" :title="t('Undo this change?')" @close="confirmChange = undefined">
      <template v-if="confirmChange">
        <p class="muted">
          {{ t("This adds a change that reverses change") }} <span class="mono">#{{ confirmChange.id }}</span>{{ t(", leaving the earlier history untouched.") }}
        </p>
        <div :class="CODELINE">
          <code>{{ confirmChange.summary }}</code>
        </div>
        <p v-if="undoing.error.value" :class="ERROR_TEXT" role="alert">
          {{ undoing.error.value }}
        </p>
      </template>
      <template #footer>
        <Button :disabled="undoing.busy.value" @click="confirmChange = undefined">
          {{ t("Cancel") }}
        </Button>
        <Button variant="primary" :disabled="undoing.busy.value" @click="performUndo">
          {{ undoing.busy.value ? t("Undoing…") : t("Undo") }}
        </Button>
      </template>
    </Dialog>
  </section>
</template>
