<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type {
  MemoryCommitView,
  MemoryFileEntry,
  ProjectSummary,
} from "@shared/api/contract.ts";
import type { MemoryScope } from "@shared/contracts/index.ts";
import { computed, onUnmounted, ref, watch } from "vue";
import { errorText } from "../errors.ts";
import { focusFirst, onRovingKeydown, trapTab, useFocusReturn } from "../focus.ts";
import { t } from "../i18n.ts";
import { classifyCommitAuthor, type MemoryAuthor, parseGitDiff } from "../memory.ts";
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
const commits = ref<MemoryCommitView[]>([]);
const uncommittedRaw = ref("");
const commitDiffs = ref<Record<string, string>>({});
const selected = ref<string>();
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
const confirmCommit = ref<MemoryCommitView>();
const confirmEl = ref<HTMLElement>();
useFocusReturn(
  () => confirmCommit.value !== undefined,
  () => focusFirst(confirmEl.value),
);

function onConfirmKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    confirmCommit.value = undefined;
    return;
  }
  trapTab(event, confirmEl.value);
}
const reverting = useSubmit();

let requestSeq = 0;
let filesSeq = 0;

const AUTHOR_META: Record<MemoryAuthor, { icon: "moon" | "radio" | "user" | "commit"; label: string; badgeClass: string }> = {
  dreaming: { icon: "moon", label: "Dreaming", badgeClass: "dreaming" },
  router: { icon: "radio", label: "Router", badgeClass: "" },
  user: { icon: "user", label: t("You"), badgeClass: "user" },
  eevee: { icon: "commit", label: "Eevee", badgeClass: "" },
};

const uncommittedDiffs = computed(() => parseGitDiff(uncommittedRaw.value));
const hasUncommitted = computed(() => uncommittedRaw.value.trim() !== "");

const selectedCommit = computed(() =>
  selected.value && selected.value !== "uncommitted"
    ? commits.value.find((c) => c.commit === selected.value)
    : undefined,
);

const selectedCommitDiffs = computed(() => {
  const c = selectedCommit.value;
  if (!c) return [];
  const raw = commitDiffs.value[`${scope.value}:${c.commit}`] ?? "";
  return parseGitDiff(raw);
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
  confirmCommit,
  (val) => emit("modal-change", val !== undefined),
);

onUnmounted(() => {
  emit("modal-change", false);
});

async function loadCommitDiff(targetScope: MemoryScope, commit: string): Promise<void> {
  const cacheKey = `${targetScope}:${commit}`;
  if (commitDiffs.value[cacheKey] !== undefined) {
    diffError.value = undefined;
    return;
  }
  loadingDiff.value = true;
  diffError.value = undefined;
  try {
    const res = await props.client.call(
      "GET /api/projects/:project/memory/:scope/commits/:commit",
      { project: props.project.id, scope: targetScope, commit },
    );
    commitDiffs.value = { ...commitDiffs.value, [cacheKey]: res.diff };
  } catch (err) {
    diffError.value = errorText(err);
  } finally {
    loadingDiff.value = false;
  }
}

async function loadScope(preferredSelection?: string): Promise<void> {
  const token = ++requestSeq;
  const targetScope = scope.value;
  loadingList.value = true;
  listError.value = undefined;
  diffError.value = undefined;
  try {
    const [logRes, diffRes] = await Promise.all([
      props.client.call("GET /api/projects/:project/memory/:scope/log", {
        project: props.project.id,
        scope: targetScope,
      }),
      props.client.call("GET /api/projects/:project/memory/:scope/diff", {
        project: props.project.id,
        scope: targetScope,
      }),
    ]);
    if (token !== requestSeq) return;
    commits.value = logRes.commits;
    uncommittedRaw.value = diffRes.diff;

    let nextSel = preferredSelection;
    if (
      nextSel !== "uncommitted" &&
      (!nextSel || !logRes.commits.some((c) => c.commit === nextSel))
    ) {
      nextSel = diffRes.diff.trim() !== "" ? "uncommitted" : logRes.commits[0]?.commit;
    }
    selected.value = nextSel;
    if (nextSel && nextSel !== "uncommitted") {
      await loadCommitDiff(targetScope, nextSel);
    }
  } catch (err) {
    if (token !== requestSeq) return;
    listError.value = errorText(err);
    commits.value = [];
    uncommittedRaw.value = "";
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

async function selectItem(id: string): Promise<void> {
  selected.value = id;
  mobileDetail.value = true;
  if (id !== "uncommitted") {
    await loadCommitDiff(scope.value, id);
  }
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

const authorOf = (commit: MemoryCommitView) => AUTHOR_META[classifyCommitAuthor(commit.subject)];

function canRevert(commit: MemoryCommitView): boolean {
  return commit.subject.trim() !== "memory: init";
}

async function performRevert(): Promise<void> {
  const target = confirmCommit.value;
  if (!target) return;
  const ok = await reverting.run(async () => {
    await props.client.call(
      "POST /api/projects/:project/memory/:scope/revert",
      { project: props.project.id, scope: scope.value },
      { commit: target.commit },
    );
  });
  if (ok) {
    confirmCommit.value = undefined;
    commitDiffs.value = {};
    fileContents.value = {};
    showToast(t("Reverted {commit} · added a revert commit", { commit: target.commit }));
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
          <Skeleton v-else-if="loadingList && commits.length === 0" />
          <div v-else class="list">
            <button
              v-if="hasUncommitted"
              type="button"
              class="commit"
              :class="{ on: selected === 'uncommitted' }"
              :title="t('The next commit records this as user edit')"
              @click="selectItem('uncommitted')"
            >
              <span class="who pending"><Icon name="pencil" size="xs" /></span>
              <span class="subj">{{ t("Uncommitted changes") }}</span>
              <span class="meta ellipsis">{{ uncommittedDiffs.map((d) => d.file).join(t(", ")) }}</span>
            </button>
            <button
              v-for="commit in commits"
              :key="commit.commit"
              type="button"
              class="commit"
              :class="{ on: selected === commit.commit }"
              @click="selectItem(commit.commit)"
            >
              <span class="who" :class="authorOf(commit).badgeClass">
                <Icon :name="authorOf(commit).icon" size="xs" />
              </span>
              <span class="subj ellipsis">{{ commit.subject }}</span>
              <span class="meta">
                <span>{{ authorOf(commit).label }}</span>
                <span>·</span>
                <span :title="formatCommitAt(commit.at).title">{{ formatCommitAt(commit.at).relative }}</span>
                <span>·</span>
                <span class="mono">{{ commit.commit }}</span>
              </span>
            </button>
            <p v-if="!hasUncommitted && commits.length === 0" class="hint">{{ t("No history") }}</p>
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
          <div v-if="selected === 'uncommitted'" key="uncommitted" class="detail-inner">
            <div class="detail-head">
              <div class="spacer">
                <h2>{{ t("Uncommitted changes") }}</h2>
                <div class="detail-meta">{{ t("The next commit records this as") }} <span class="mono">user edit</span></div>
              </div>
            </div>
            <FileDiffs :diffs="uncommittedDiffs" :empty-text="t('No uncommitted changes')" />
          </div>
          <div v-else-if="selectedCommit" :key="selectedCommit.commit" class="detail-inner">
            <div class="detail-head">
              <div class="spacer">
                <h2>{{ selectedCommit.subject }}</h2>
                <div class="detail-meta">
                  <span class="chip mono">
                    <Icon name="commit" size="xs" />
                    <span>{{ selectedCommit.commit }}</span>
                  </span>
                  <span>{{ authorOf(selectedCommit).label }}</span>
                  <span :title="formatCommitAt(selectedCommit.at).title">
                    {{ formatCommitAt(selectedCommit.at).relative }}
                  </span>
                </div>
              </div>
              <button
                v-if="canRevert(selectedCommit)"
                type="button"
                class="btn sm danger"
                @click="
                  reverting.error.value = undefined;
                  confirmCommit = selectedCommit;
                "
              >
                <Icon name="undo" size="xs" />
                <span>{{ t("Revert") }}</span>
              </button>
            </div>
            <p v-if="diffError" class="error hint">{{ diffError }}</p>
            <Skeleton v-else-if="loadingDiff" :lines="6" />
            <FileDiffs v-else :diffs="selectedCommitDiffs" :empty-text="t('No text changes')" />
          </div>
        </template>
      </div>
    </div>

    <div
      v-if="confirmCommit"
      class="overlay"
      @click.self="confirmCommit = undefined"
      @keydown="onConfirmKeydown"
    >
      <div
        ref="confirmEl"
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="revert-title"
      >
        <div class="modal-h">
          <h2 id="revert-title">{{ t("Revert this commit?") }}</h2>
          <span class="spacer" />
          <button type="button" class="btn ghost sm icon" :aria-label="t('Close')" @click="confirmCommit = undefined">
            <Icon name="x" size="sm" />
          </button>
        </div>
        <div class="modal-b">
          <p class="muted">
            {{ t("Adds a revert commit that undoes") }} <span class="mono">{{ confirmCommit.commit }}</span>{{ t("; history isn't rewritten.") }}
          </p>
          <div class="codeline">
            <code>{{ confirmCommit.subject }}</code>
          </div>
          <p v-if="reverting.error.value" class="composer-error" role="alert">
            {{ reverting.error.value }}
          </p>
        </div>
        <div class="modal-f">
          <button type="button" class="btn" :disabled="reverting.busy.value" @click="confirmCommit = undefined">
            {{ t("Cancel") }}
          </button>
          <button type="button" class="btn primary" :disabled="reverting.busy.value" @click="performRevert">
            {{ reverting.busy.value ? t("Reverting…") : t("Revert") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
