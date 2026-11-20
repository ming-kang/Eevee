<script setup lang="ts">
import type { ProjectSummary } from "@shared/api/contract.ts";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { effectiveStage } from "../board.ts";
import type { BoardState } from "../engine-data.ts";
import { buildHomeBoard, type NeedsYouRow, type RunningRow } from "../home.ts";
import { t } from "../i18n.ts";
import { STAGE_LABEL } from "../labels.ts";
import { formatRoute } from "../router.ts";
import { formatRelativeTime } from "../time.ts";
import Icon from "./Icon.vue";
import StageGlyph from "./StageGlyph.vue";

const props = defineProps<{
  projects: readonly ProjectSummary[];
  boards: Record<string, BoardState | undefined>;
}>();

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
  return row.question.ticketId;
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
    </header>
    <div class="page">
      <div class="page-inner home">
        <section class="home-block">
          <header class="home-h">
            <h2>
              {{ t("Pending") }}
              <span v-if="home.questionCount > 0" class="count user">{{ home.questionCount }}</span>
            </h2>
          </header>
          <div class="rows">
            <a
              v-for="row in home.needsYou"
              :key="row.kind === 'question' ? row.question.id : `r:${row.pid}`"
              class="row"
              :href="formatRoute({ name: 'chat', pid: row.pid })"
            >
              <StageGlyph :stage="row.kind === 'question' ? 'answer' : 'blocked'" />
              <span class="r-main">
                <span class="r-t ellipsis">{{ needsYouTitle(row) }}</span>
                <span class="r-d ellipsis"
                  >{{ row.project
                  }}<template v-if="needsYouRest(row)"> · {{ needsYouRest(row) }}</template></span
                >
              </span>
              <span v-if="row.kind === 'question'" class="h-when">
                {{ formatRelativeTime(row.question.askedAt, nowMs, "short") }}
              </span>
              <Icon name="chevR" size="sm" class="go" />
            </a>
            <div v-if="home.needsYou.length === 0" class="row">
              <span class="r-d">{{ t("No questions waiting") }}</span>
            </div>
          </div>
        </section>

        <section class="home-block">
          <header class="home-h">
            <h2>
              {{ t("Running") }}
              <span v-if="home.runningCount > 0" class="count">{{ home.runningCount }}</span>
            </h2>
          </header>
          <div class="rows">
            <a
              v-for="row in home.running"
              :key="row.kind === 'ticket' ? row.view.ticket.id : `r:${row.pid}`"
              class="row"
              :href="
                formatRoute(
                  row.kind === 'ticket'
                    ? { name: 'worker', pid: row.pid, tid: row.view.ticket.id }
                    : { name: 'chat', pid: row.pid },
                )
              "
            >
              <StageGlyph :stage="row.kind === 'ticket' ? effectiveStage(row.view) : 'working'" />
              <span class="r-main">
                <span class="r-t ellipsis">
                  {{ row.kind === "ticket" ? row.view.ticket.title : t("Router") }}
                </span>
                <span class="r-d ellipsis"
                  ><template v-if="row.kind === 'ticket'">{{ row.view.ticket.id }} · </template
                  >{{ row.project
                  }}<template v-if="row.kind === 'ticket'"> · {{ runningRest(row) }}</template></span
                >
              </span>
              <span v-if="row.kind === 'ticket'" class="h-when">
                {{ formatRelativeTime(row.at, nowMs, "short") }}
              </span>
              <Icon name="chevR" size="sm" class="go" />
            </a>
            <div v-if="home.running.length === 0" class="row">
              <span class="r-d">{{ t("Nothing is running") }}</span>
            </div>
          </div>
        </section>

        <section class="home-block">
          <header class="home-h">
            <h2>
              {{ t("Recently done") }}
              <span v-if="home.doneCount > 0" class="count">{{ home.doneCount }}</span>
            </h2>
          </header>
          <div class="rows">
            <a
              v-for="row in home.done"
              :key="row.view.ticket.id"
              class="row"
              :href="formatRoute({ name: 'worker', pid: row.pid, tid: row.view.ticket.id })"
            >
              <StageGlyph :stage="effectiveStage(row.view)" />
              <span class="r-main">
                <span class="r-t ellipsis">{{ row.view.ticket.title }}</span>
                <span class="r-d ellipsis"
                  >{{ row.view.ticket.id }} · {{ row.project }}</span
                >
              </span>
              <span class="h-when">{{ formatRelativeTime(row.closedAt, nowMs, "short") }}</span>
              <Icon name="chevR" size="sm" class="go" />
            </a>
            <div v-if="home.done.length === 0" class="row">
              <span class="r-d">{{ t("Nothing finished in the last day") }}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
