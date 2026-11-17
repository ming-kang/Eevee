<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type {
  MemoryCommitView,
  MemoryFileEntry,
  ProjectSummary,
} from "@shared/api/contract.ts";
import type { MemoryScope } from "@shared/contracts/index.ts";
import { computed, onUnmounted, ref, watch } from "vue";
import { focusFirst, onRovingKeydown, trapTab, useFocusReturn } from "../focus.ts";
import { classifyCommitAuthor, type MemoryAuthor, parseGitDiff } from "../memory.ts";
import { useSubmit } from "../submit.ts";
import { formatRelativeTime } from "../time.ts";
import { showToast } from "../toasts.ts";
import FileDiffs from "./FileDiffs.vue";
import Icon from "./Icon.vue";

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
  user: { icon: "user", label: "你", badgeClass: "user" },
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
    diffError.value = err instanceof Error ? err.message : String(err);
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
    listError.value = err instanceof Error ? err.message : String(err);
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
    fileError.value = err instanceof Error ? err.message : String(err);
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
    filesError.value = err instanceof Error ? err.message : String(err);
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
    showToast(`已撤销 ${target.commit} · 新建了一个 revert commit`);
    await loadScope();
    if (tab.value === "files") await loadFiles();
    else files.value = [];
  }
}
</script>

<template>
  <section class="page-wrap">
    <header class="header">
      <button type="button" class="btn ghost icon menu-btn" title="菜单" aria-label="菜单" @click="$emit('open-side')">
        <Icon name="menu" />
      </button>
      <h1>记忆</h1>
      <span class="muted ellipsis hide-sm" style="font-size: 12px">{{ project.title }}</span>
    </header>

    <div class="split" :class="{ 'has-detail': mobileDetail }">
      <div class="split-list">
        <div class="list-head">
          <div class="seg" style="width: 100%" role="group" aria-label="记忆范围">
            <button
              type="button"
              style="flex: 1"
              :class="{ on: scope === 'project' }"
              :aria-pressed="scope === 'project'"
              @click="scope = 'project'"
            >
              项目记忆
            </button>
            <button
              type="button"
              style="flex: 1"
              :class="{ on: scope === 'global' }"
              :aria-pressed="scope === 'global'"
              @click="scope = 'global'"
            >
              全局记忆
            </button>
          </div>
          <div
            class="seg"
            style="width: 100%"
            role="tablist"
            aria-label="记忆视图"
            @keydown="onRovingKeydown($event, MEMORY_TABS, tab, (key) => (tab = key))"
          >
            <button
              type="button"
              role="tab"
              :aria-selected="tab === 'history'"
              :tabindex="tab === 'history' ? 0 : -1"
              style="flex: 1"
              :class="{ on: tab === 'history' }"
              @click="tab = 'history'"
            >
              历史
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="tab === 'files'"
              :tabindex="tab === 'files' ? 0 : -1"
              style="flex: 1"
              :class="{ on: tab === 'files' }"
              @click="tab = 'files'"
            >
              文件
            </button>
          </div>
        </div>

        <template v-if="tab === 'history'">
          <p v-if="listError" class="error hint" style="padding: 8px 14px">{{ listError }}</p>
          <p v-else-if="loadingList && commits.length === 0" class="hint" style="padding: 8px 14px">
            正在加载记忆历史…
          </p>
          <div v-else style="padding: 0 6px 16px; display: flex; flex-direction: column; gap: 1px">
            <button
              v-if="hasUncommitted"
              type="button"
              class="commit"
              :class="{ on: selected === 'uncommitted' }"
              @click="selectItem('uncommitted')"
            >
              <span class="who pending"><Icon name="pencil" size="xs" /></span>
              <span class="subj">未提交的改动</span>
              <span class="meta">
                <template v-if="uncommittedDiffs.length > 0">
                  {{ uncommittedDiffs.map((d) => d.file).join("、") }} ·
                </template>
                下次提交时记为 user edit
              </span>
            </button>

            <button
              v-for="commit in commits"
              :key="commit.commit"
              type="button"
              class="commit"
              :class="{ on: selected === commit.commit }"
              @click="selectItem(commit.commit)"
            >
              <span class="who" :class="AUTHOR_META[classifyCommitAuthor(commit.subject)].badgeClass">
                <Icon :name="AUTHOR_META[classifyCommitAuthor(commit.subject)].icon" size="xs" />
              </span>
              <span class="subj ellipsis">{{ commit.subject }}</span>
              <span class="meta">
                <span class="mono">{{ commit.commit }}</span>
                <span>·</span>
                <span>{{ AUTHOR_META[classifyCommitAuthor(commit.subject)].label }}</span>
                <span>·</span>
                <span :title="formatCommitAt(commit.at).title">
                  {{ formatCommitAt(commit.at).relative }}
                </span>
              </span>
            </button>

            <p v-if="!hasUncommitted && commits.length === 0" class="hint" style="padding: 8px 8px">
              还没有记忆提交记录。
            </p>
          </div>
        </template>

        <template v-else>
          <p v-if="filesError" class="error hint" style="padding: 8px 14px">{{ filesError }}</p>
          <p v-else-if="loadingFiles && files.length === 0" class="hint" style="padding: 8px 14px">
            正在加载记忆文件…
          </p>
          <div v-else style="padding: 0 6px 16px; display: flex; flex-direction: column; gap: 1px">
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
              <span class="subj ellipsis mono" style="font-size: 12px">{{ file.path }}</span>
              <span class="meta">
                <span v-if="file.path === 'MEMORY.md'">索引 ·</span>
                <span>{{ formatBytes(file.size) }}</span>
              </span>
            </button>
            <p v-if="files.length === 0" class="hint" style="padding: 8px 8px">
              当前范围内没有记忆文件。
            </p>
          </div>
        </template>
      </div>

      <div class="split-detail">
        <button
          v-if="mobileDetail"
          type="button"
          class="btn ghost sm menu-btn"
          style="margin: 10px 0 0 10px"
          @click="mobileDetail = false"
        >
          <Icon name="chevL" size="xs" />
          <span>返回列表</span>
        </button>

        <template v-if="tab === 'files'">
          <div v-if="selectedFile" class="detail-inner">
            <div class="detail-head">
              <div style="flex: 1; min-width: 0">
                <h2 class="mono" style="font-size: 15px">{{ selectedFile }}</h2>
                <div class="hint" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
                  <span v-if="selectedFileContent !== undefined">{{ selectedFileLines.length }} 行</span>
                  <span v-if="activeFileEntry">· {{ formatBytes(activeFileEntry.size) }}</span>
                  <span>· {{ scope === "project" ? "项目记忆" : "全局记忆" }}</span>
                </div>
              </div>
              <button
                type="button"
                class="btn sm"
                @click="showToast('可直接用编辑器修改记忆目录中的文件，Eevee 下次提交前会单独记为 user edit')"
              >
                <Icon name="pencil" size="xs" />
                <span>如何编辑</span>
              </button>
            </div>

            <p v-if="fileError" class="error hint">{{ fileError }}</p>
            <p v-else-if="loadingFile && selectedFileContent === undefined" class="hint">正在读取文件内容…</p>
            <div v-else-if="selectedFileContent !== undefined" class="card file-diff">
              <div class="card-h">
                <Icon name="file" size="sm" />
                <span class="path">{{ selectedFile }}</span>
                <span class="spacer" />
                <span class="muted" style="font-size: 12px">{{ selectedFileLines.length }} 行</span>
              </div>
              <div class="diff single">
                <div v-for="(line, idx) in selectedFileLines" :key="idx" class="ln">
                  <span>{{ idx + 1 }}</span>
                  <span class="mk" />
                  <span>{{ line }}</span>
                </div>
              </div>
            </div>

            <p class="hint">新写入的记忆从之后创建或重置的对话起生效，不影响正在进行的对话。</p>
          </div>
          <div v-else class="empty" style="padding-top: 80px">
            <p class="muted">从左侧选择一个记忆文件查看内容。</p>
          </div>
        </template>

        <template v-else>
          <div v-if="selected === 'uncommitted'" class="detail-inner">
          <div class="detail-head">
            <div style="flex: 1">
              <h2>未提交的改动</h2>
              <div class="hint">
                你在编辑器里改了这些文件。Eevee 下次提交前会先把它们单独提交为一个
                <span class="mono">user edit</span>，历史里分得清是谁改的。
              </div>
            </div>
          </div>
          <FileDiffs :diffs="uncommittedDiffs" empty-text="当前工作区没有未提交改动。" />
        </div>

        <div v-else-if="selectedCommit" class="detail-inner">
          <div class="detail-head">
            <div style="flex: 1; min-width: 0">
              <h2>{{ selectedCommit.subject }}</h2>
              <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap" class="hint">
                <span class="chip mono">
                  <Icon name="commit" size="xs" />
                  <span>{{ selectedCommit.commit }}</span>
                </span>
                <span style="display: inline-flex; gap: 4px; align-items: center">
                  <Icon :name="AUTHOR_META[classifyCommitAuthor(selectedCommit.subject)].icon" size="xs" />
                  <span>{{ AUTHOR_META[classifyCommitAuthor(selectedCommit.subject)].label }}</span>
                </span>
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
              <span>撤销此提交</span>
            </button>
          </div>

          <p v-if="diffError" class="error hint">{{ diffError }}</p>
          <p v-else-if="loadingDiff" class="hint">正在读取改动…</p>
          <FileDiffs v-else :diffs="selectedCommitDiffs" empty-text="这个提交没有文本文件改动。" />

          <p class="hint">新写入的记忆从之后创建或重置的对话起生效，不影响正在进行的对话。</p>
        </div>

        <div v-else class="empty" style="padding-top: 80px">
          <p class="muted">从左侧选择一次记忆提交查看改动详情。</p>
        </div>
        </template>
      </div>
    </div>

    <div
      v-if="confirmCommit"
      class="overlay"
      style="position: fixed; z-index: 45"
      @click.self="confirmCommit = undefined"
      @keydown="onConfirmKeydown"
    >
      <div
        ref="confirmEl"
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="revert-title"
        style="width: min(440px, calc(100% - 32px))"
      >
        <div class="modal-h">
          <h2 id="revert-title">撤销这次记忆提交？</h2>
          <span class="spacer" />
          <button
            type="button"
            class="btn ghost sm icon"
            aria-label="关闭"
            @click="confirmCommit = undefined"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
        <div class="modal-b">
          <p style="margin: 0; font-size: 13px" class="muted">
            会新建一个 revert commit 抵消 <span class="mono">{{ confirmCommit.commit }}</span> 的改动，历史不会被改写，之后还能再撤销回来。
          </p>
          <div class="codeline">
            <code>{{ confirmCommit.subject }}</code>
          </div>
          <p class="hint" style="margin: 0">从之后创建或重置的对话起生效。</p>
          <p
            v-if="reverting.error.value"
            class="error"
            role="alert"
            style="margin: 0; font-size: 12px"
          >
            {{ reverting.error.value }}
          </p>
        </div>
        <div class="modal-f">
          <button
            type="button"
            class="btn"
            :disabled="reverting.busy.value"
            @click="confirmCommit = undefined"
          >
            取消
          </button>
          <button
            type="button"
            class="btn primary"
            :disabled="reverting.busy.value"
            @click="performRevert"
          >
            {{ reverting.busy.value ? "正在撤销…" : "撤销提交" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
