<script setup lang="ts">
import type { ProjectSummary, TicketView } from "@shared/protocol/contract.ts";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { effectiveStage, type VisualStage } from "../../lib/board.ts";
import type { BoardState } from "../../composables/engine-data.ts";
import { buildOverviewBoard, overviewProjectId, pendingRoute, type PendingRow } from "../../lib/overview.ts";
import { t } from "../../lib/i18n.ts";
import { reportSummary, STAGE_LABEL } from "../../lib/labels.ts";
import { formatRoute, type Route } from "../../lib/router.ts";
import { formatRelativeTime } from "../../lib/time.ts";
import { fieldClass } from "../../ui/field.ts";
import { EMPTY } from "../../ui/surface.ts";
import Icon from "../../ui/Icon.vue";
import StageGlyph from "../project/StageGlyph.vue";
import Button from "../../ui/Button.vue";
import { displayId } from "../../lib/ids.ts";

const props = defineProps<{
  projects: readonly ProjectSummary[];
  boards: Record<string, BoardState | undefined>;
}>();

defineEmits<{ "new-project": [] }>();

const FILTER_KEY = "eevee.overviewProject";
const storedProject = ref(localStorage.getItem(FILTER_KEY));
const projectFilter = computed({
  get: () => overviewProjectId(props.projects, storedProject.value),
  set: (value: string) => {
    storedProject.value = value;
    localStorage.setItem(FILTER_KEY, value);
  },
});
const nowMs = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  clockTimer = setInterval(() => {
    nowMs.value = Date.now();
  }, 60_000);
});
onUnmounted(() => {
  if (clockTimer !== undefined) clearInterval(clockTimer);
});

const board = computed(() =>
  buildOverviewBoard({ projects: props.projects, boards: props.boards, now: nowMs.value, projectId: projectFilter.value }),
);

type Card = {
  key: string;
  project: string;
  title: string;
  ticket?: string;
  stage: VisualStage;
  label: string;
  context?: string;
  at?: number;
  route: Route;
};

function ticketCard(row: { pid: string; project: string; view: TicketView }, context?: string, at?: number): Card {
  const stage = effectiveStage(row.view);
  const latest = row.view.reports.reduce<TicketView["reports"][number] | undefined>(
    (last, report) => !last || report.seq > last.seq ? report : last, undefined,
  );
  return {
    key: `${row.pid}:${row.view.ticket.id}`,
    project: row.project,
    title: row.view.ticket.title,
    ticket: displayId(row.view.ticket.id),
    stage,
    label: STAGE_LABEL[stage],
    context: context ?? (latest ? reportSummary(latest) : row.view.ticket.closeNote),
    at,
    route: { name: "worker", pid: row.pid, tid: row.view.ticket.id },
  };
}

function pendingCard(row: PendingRow): Card {
  if (row.kind === "ticket") return ticketCard(row, undefined, row.at);
  if (row.kind === "question") {
    return {
      key: `${row.pid}:${row.question.id}`,
      project: row.project,
      title: row.view?.ticket.title ?? (row.question.ticketId ? row.text : t("Router")),
      ticket: row.question.ticketId ? displayId(row.question.ticketId) : undefined,
      stage: "answer",
      label: t("Needs answer"),
      context: row.text,
      at: row.question.askedAt,
      route: pendingRoute(row),
    };
  }
  return {
    key: `${row.pid}:${row.kind === "proposal" ? row.proposal.id : "router"}`,
    project: row.project,
    title: row.kind === "proposal" ? t("Memory proposal") : t("Router"),
    stage: row.kind === "proposal" ? "answer" : "blocked",
    label: row.kind === "proposal" ? t("Pending approval") : STAGE_LABEL.blocked,
    context: row.kind === "proposal" ? row.proposal.summary : row.failure,
    route: pendingRoute(row),
  };
}

const columns = computed(() => [
  { key: "pending", label: t("Pending"), empty: t("Nothing pending"), count: board.value.pendingCount, cards: board.value.pending.map(pendingCard) },
  { key: "running", label: t("Running"), empty: t("Nothing is running"), count: board.value.runningCount, cards: board.value.running.map((row): Card =>
    row.kind === "ticket"
      ? ticketCard(row, row.runningJobs ? t("{n} job|{n} jobs", { n: row.runningJobs }) : undefined, row.at)
      : { key: `${row.pid}:router`, project: row.project, title: t("Router"), stage: "working", label: t("Running"), route: { name: "chat", pid: row.pid } },
  ) },
  { key: "done", label: t("Recently done"), empty: t("Nothing finished in the last day"), count: board.value.doneCount, cards: board.value.done.map((row) => ticketCard(row, undefined, row.closedAt)) },
]);
</script>

<template>
  <section class="@container/overview page-wrap overflow-hidden">
    <header class="header">
      <h1>{{ t("Overview") }}</h1>
      <span class="spacer" />
      <label for="overview-project" class="sr">{{ t("Filter projects") }}</label>
      <select id="overview-project" v-model="projectFilter" :class="fieldClass({ inline: true, size: 'sm' })" class="max-w-[min(35vw,240px)] min-w-0 truncate pr-7">
        <option value="">{{ t("All projects") }}</option>
        <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.title }}</option>
      </select>
      <Button size="sm" @click="$emit('new-project')">
        <Icon name="plus" size="sm" />
        <span>{{ t("New project") }}</span>
      </Button>
    </header>
    <div v-if="projects.length === 0" :class="EMPTY">
      <span class="grid size-12 place-items-center rounded-xl border border-border bg-surface-2 text-fg-muted">
        <Icon name="folderPlus" size="lg" />
      </span>
      <h3>{{ t("No projects yet") }}</h3>
      <p>{{ t("Create a project to get started.") }}</p>
      <Button variant="primary" @click="$emit('new-project')">
        <Icon name="plus" size="sm" />
        <span>{{ t("New project") }}</span>
      </Button>
    </div>
    <div v-else class="grid min-h-0 flex-1 grid-cols-3 gap-5 overflow-hidden p-5 @max-[960px]/overview:grid-cols-1 @max-[960px]/overview:auto-rows-max @max-[960px]/overview:gap-6 @max-[960px]/overview:overflow-y-auto @max-[960px]/overview:p-3">
      <section v-for="column in columns" :key="column.key" :aria-labelledby="`overview-${column.key}`" class="flex min-h-0 min-w-0 flex-col overflow-hidden @max-[960px]/overview:overflow-visible">
        <header class="flex h-10 shrink-0 items-center gap-2 px-px">
          <h2 :id="`overview-${column.key}`" class="text-sm font-medium">{{ column.label }}</h2>
          <span class="text-xs text-fg-subtle tabular-nums">{{ column.count }}</span>
        </header>
        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-px @max-[960px]/overview:overflow-visible">
          <a v-for="card in column.cards" :key="card.key" :href="formatRoute(card.route)" class="flex shrink-0 flex-col gap-2 rounded-xl border border-border bg-surface p-4 text-fg transition-colors hover:bg-hover focus-visible:shadow-(--ring)">
            <div class="flex min-w-0 items-center gap-2 text-xs text-fg-subtle">
              <span class="min-w-0 flex-1 truncate">{{ card.project }}</span>
            </div>
            <div class="line-clamp-2 text-base leading-5 font-medium">
              <span v-if="card.ticket" class="mr-1.5 font-mono text-xs text-fg-muted">{{ card.ticket }}</span>{{ card.title }}
            </div>
            <p v-if="card.context" class="line-clamp-2 text-sm leading-5 text-fg-muted">{{ card.context }}</p>
            <div class="flex items-center gap-2 text-xs text-fg-subtle">
              <StageGlyph :stage="card.stage" class="size-3 shrink-0" />
              <span>{{ card.label }}</span>
              <span class="spacer" />
              <time v-if="card.at !== undefined" :datetime="new Date(card.at).toISOString()">{{ formatRelativeTime(card.at, nowMs, "short") }}</time>
            </div>
          </a>
          <p v-if="column.cards.length === 0" class="px-1 py-3 text-xs text-fg-muted">{{ column.empty }}</p>
        </div>
      </section>
    </div>
  </section>
</template>
