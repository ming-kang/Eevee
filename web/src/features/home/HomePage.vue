<script setup lang="ts">
import type { ProjectSummary } from "@shared/protocol/contract.ts";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { effectiveStage } from "../../lib/board.ts";
import type { BoardState } from "../../composables/engine-data.ts";
import { buildHomeBoard, type NeedsYouRow, type RunningRow } from "../../lib/home.ts";
import { t } from "../../lib/i18n.ts";
import { STAGE_LABEL } from "../../lib/labels.ts";
import { formatRoute } from "../../lib/router.ts";
import { formatRelativeTime } from "../../lib/time.ts";
import Icon from "../../ui/Icon.vue";
import StageGlyph from "../project/StageGlyph.vue";
import Button from "../../ui/Button.vue";
import { ROW_DESC, row as rowClass, rowMain, rowTitle, rows } from "../../ui/rows.ts";
import { displayId } from "../../lib/ids.ts";

const props = defineProps<{
  projects: readonly ProjectSummary[];
  boards: Record<string, BoardState | undefined>;
}>();

defineEmits<{ "new-project": [] }>();

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

const home = computed(() =>
  buildHomeBoard({ projects: props.projects, boards: props.boards, now: nowMs.value }),
);

function needsYouTitle(row: NeedsYouRow): string {
  return row.kind === "question" ? row.text || row.question.id : row.failure;
}

/** The text after the project name in a Needs-you row's detail. */
function needsYouRest(row: NeedsYouRow): string | undefined {
  if (row.kind === "router") return t("The Router's last run failed");
  return row.question.ticketId === undefined ? undefined : displayId(row.question.ticketId);
}

/** The text after the project name in a running ticket's detail. */
function runningRest(row: Extract<RunningRow, { kind: "ticket" }>): string {
  const parts = [STAGE_LABEL[effectiveStage(row.view)]];
  if (row.runningJobs > 0) parts.push(t("{n} job|{n} jobs", { n: row.runningJobs }));
  return parts.join(" · ");
}
</script>

<template>
  <section class="page-wrap">
    <header class="header">
      <h1>{{ t("Now") }}</h1>
      <span class="spacer" />
      <Button size="sm" @click="$emit('new-project')">
        <Icon name="plus" size="sm" />
        <span>{{ t("New project") }}</span>
      </Button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto grid max-w-[calc(900px*var(--ev-scale))] grid-cols-1 content-start gap-8 px-(--ev-gutter) pt-8 pb-12 @max-[54.2857em]/vp:px-4 @max-[54.2857em]/vp:pb-10 @min-[900px]/vp:grid-cols-2">
        <section class="min-w-0 @min-[900px]/vp:first:col-span-full">
          <header class="mx-1 mt-1 mb-2 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:tracking-[-0.015em] [&_h2]:text-fg">
            <h2>
              {{ t("Pending") }}
              <span v-if="home.needsYou.length > 0" class="count user">{{ home.needsYou.length }}</span>
            </h2>
          </header>
          <div :class="rows({ spaced: true })">
            <a
              v-for="row in home.needsYou"
              :key="row.kind === 'question' ? row.question.id : `r:${row.pid}`"
              class="border border-border bg-surface [&>.glyph]:mt-0.5 [&>.glyph]:self-start" :class="rowClass({ size: 'home', link: true })"
              :href="formatRoute({ name: 'chat', pid: row.pid, ...(row.kind === 'question' ? { qid: row.question.id } : {}) })"
            >
              <StageGlyph :stage="row.kind === 'question' ? 'answer' : 'blocked'" />
              <span :class="rowMain({ loose: true })">
                <span :class="rowTitle({ clamp: true })">{{ needsYouTitle(row) }}</span>
                <span class="ellipsis" :class="ROW_DESC"
                  >{{ row.project
                  }}<template v-if="needsYouRest(row)"> · {{ needsYouRest(row) }}</template></span
                >
              </span>
              <span v-if="row.kind === 'question'" class="flex-none text-xs text-fg-subtle tabular-nums">
                {{ formatRelativeTime(row.question.askedAt, nowMs, "short") }}
              </span>
              <Icon name="chevR" size="sm" class="go" />
            </a>
            <div v-if="home.needsYou.length === 0" :class="rowClass({ size: 'home' })">
              <span :class="ROW_DESC">{{ t("No questions waiting") }}</span>
            </div>
          </div>
        </section>

        <section class="min-w-0 @min-[900px]/vp:first:col-span-full">
          <header class="mx-1 mt-1 mb-2 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:tracking-[-0.015em] [&_h2]:text-fg">
            <h2>
              {{ t("Running") }}
              <span v-if="home.runningCount > 0" class="count">{{ home.runningCount }}</span>
            </h2>
          </header>
          <div :class="rows({ plain: true })">
            <a
              v-for="row in home.running"
              :key="row.kind === 'ticket' ? row.view.ticket.id : `r:${row.pid}`"
              :class="rowClass({ size: 'home', link: true })"
              :href="
                formatRoute(
                  row.kind === 'ticket'
                    ? { name: 'worker', pid: row.pid, tid: row.view.ticket.id }
                    : { name: 'chat', pid: row.pid },
                )
              "
            >
              <StageGlyph :stage="row.kind === 'ticket' ? effectiveStage(row.view) : 'working'" />
              <span :class="rowMain({ loose: true })">
                <span class="ellipsis" :class="rowTitle({ block: true })">
                  {{ row.kind === "ticket" ? row.view.ticket.title : t("Router") }}
                </span>
                <span class="ellipsis" :class="ROW_DESC"
                  ><template v-if="row.kind === 'ticket'">{{ displayId(row.view.ticket.id) }} · </template
                  >{{ row.project
                  }}<template v-if="row.kind === 'ticket'"> · {{ runningRest(row) }}</template></span
                >
              </span>
              <span v-if="row.kind === 'ticket'" class="flex-none text-xs text-fg-subtle tabular-nums">
                {{ formatRelativeTime(row.at, nowMs, "short") }}
              </span>
              <Icon name="chevR" size="sm" class="go" />
            </a>
            <div v-if="home.running.length === 0" :class="rowClass({ size: 'home' })">
              <span :class="ROW_DESC">{{ t("Nothing is running") }}</span>
            </div>
          </div>
        </section>

        <section class="min-w-0 @min-[900px]/vp:first:col-span-full">
          <header class="mx-1 mt-1 mb-2 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:tracking-[-0.015em] [&_h2]:text-fg">
            <h2>
              {{ t("Recently done") }}
              <span v-if="home.doneCount > 0" class="count">{{ home.doneCount }}</span>
            </h2>
          </header>
          <div :class="rows({ plain: true })">
            <a
              v-for="row in home.done"
              :key="row.view.ticket.id"
              :class="rowClass({ size: 'home', link: true })"
              :href="formatRoute({ name: 'worker', pid: row.pid, tid: row.view.ticket.id })"
            >
              <StageGlyph :stage="effectiveStage(row.view)" />
              <span :class="rowMain({ loose: true })">
                <span class="ellipsis" :class="rowTitle({ block: true })">{{ row.view.ticket.title }}</span>
                <span class="ellipsis" :class="ROW_DESC"
                  >{{ displayId(row.view.ticket.id) }} · {{ row.project }}</span
                >
              </span>
              <span class="flex-none text-xs text-fg-subtle tabular-nums">{{ formatRelativeTime(row.closedAt, nowMs, "short") }}</span>
              <Icon name="chevR" size="sm" class="go" />
            </a>
            <div v-if="home.done.length === 0" :class="rowClass({ size: 'home' })">
              <span :class="ROW_DESC">{{ t("Nothing finished in the last day") }}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
