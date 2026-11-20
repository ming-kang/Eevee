<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { ProjectSummary, UsageSummary, UsageView } from "@shared/api/contract.ts";
import { computed, ref, watch } from "vue";
import { errorText } from "../../lib/errors.ts";
import { t } from "../../lib/i18n.ts";
import Icon from "../../ui/Icon.vue";
import Skeleton from "../../ui/Skeleton.vue";
import Button from "../../ui/Button.vue";
import { PANEL, SECTION_H, TABLE } from "../../ui/surface.ts";
import { row as rowClass, rows } from "../../ui/rows.ts";
import { displayId } from "../../lib/ids.ts";

const props = defineProps<{
  client: Client;
  project: ProjectSummary;
}>();

defineEmits<{
  "open-ticket": [ticketId: string];
}>();

const usage = ref<UsageView>();
const loading = ref(false);
const error = ref<string>();

let seq = 0;

async function loadUsage(): Promise<void> {
  const token = ++seq;
  loading.value = true;
  error.value = undefined;
  try {
    const view = await props.client.call("GET /api/projects/:project/usage", {
      project: props.project.id,
    });
    if (token !== seq) return;
    usage.value = view;
  } catch (err) {
    if (token !== seq) return;
    error.value = errorText(err);
  } finally {
    if (token === seq) loading.value = false;
  }
}

watch(() => props.project.id, () => void loadUsage(), { immediate: true });

function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

const cacheHitPercent = computed(() => {
  if (!usage.value) return "0%";
  const { input, cacheRead } = usage.value.total;
  const total = input + cacheRead;
  if (total === 0) return "0%";
  return `${Math.round((cacheRead / total) * 100)}%`;
});

const modelRows = computed(() => {
  if (!usage.value) return [];
  return Object.entries(usage.value.models)
    .map(([model, summary]) => ({ model, summary }))
    .sort((a, b) => b.summary.cost - a.summary.cost || b.summary.input - a.summary.input);
});

const conversationRows = computed(() => {
  if (!usage.value) return [];
  const rows: { id?: string; title: string; summary: UsageSummary }[] = [
    { title: t("Router conversation"), summary: usage.value.router },
    ...usage.value.tickets.map((t) => ({
      id: t.ticketId,
      title: t.title,
      summary: t.usage,
    })),
  ];
  return rows;
});

const maxConversationMetric = computed(() => {
  const rows = conversationRows.value;
  if (rows.length === 0) return 1;
  const maxCost = Math.max(...rows.map((r) => r.summary.cost));
  if (maxCost > 0) return maxCost;
  const maxTokens = Math.max(...rows.map((r) => r.summary.input + r.summary.output));
  return maxTokens > 0 ? maxTokens : 1;
});

function barWidth(summary: UsageSummary): string {
  const useCost = conversationRows.value.some((r) => r.summary.cost > 0);
  const value = useCost ? summary.cost : summary.input + summary.output;
  return `${Math.min(100, (value / maxConversationMetric.value) * 100)}%`;
}
</script>

<template>
  <section class="page-wrap">
    <header class="header">
      <h1>{{ t("Usage") }}</h1>
      <span class="crumb-sep hide-sm" aria-hidden="true">/</span>
      <span class="sub ellipsis hide-sm">{{ project.title }}</span>
      <span class="spacer" />
      <Button variant="ghost" size="sm" icon :disabled="loading" :aria-label="t('Refresh')" :title="t('Refresh')" @click="loadUsage">
        <Icon name="refresh" size="sm" :spin="loading" />
      </Button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-[calc(780px*var(--ev-scale))] px-(--ev-gutter) pt-4.5 pb-12 @max-[54.2857em]/vp:px-4 @max-[54.2857em]/vp:pt-2 @max-[54.2857em]/vp:pb-10">
        <p v-if="error" class="error hint">{{ error }}</p>
        <Skeleton v-else-if="loading && !usage" />
        <template v-else-if="usage">
          <div class="grid grid-cols-4 @max-[54.2857em]/vp:grid-cols-2 [&>div]:flex [&>div]:flex-col [&>div]:gap-1 [&>div]:px-4.5 [&>div]:py-4 [&>div+div]:shadow-[inset_1px_0_0_var(--ev-separator)] @max-[54.2857em]/vp:[&>div:nth-child(3)]:shadow-[inset_0_1px_0_var(--ev-separator)] @max-[54.2857em]/vp:[&>div:nth-child(4)]:shadow-[inset_1px_0_0_var(--ev-separator),inset_0_1px_0_var(--ev-separator)] [&_.k]:text-xs [&_.k]:text-fg-muted [&_.v]:text-(length:--ev-display) [&_.v]:font-semibold [&_.v]:tracking-[-0.02em] [&_.v]:tabular-nums" :class="PANEL">
            <div :title="t('From provider bills; estimated from list prices when missing')">
              <span class="k">{{ t("Cost") }}</span>
              <span class="v">{{ formatCost(usage.total.cost) }}</span>
            </div>
            <div>
              <span class="k">{{ t("Input") }}</span>
              <span class="v">{{ formatTokens(usage.total.input) }}</span>
            </div>
            <div>
              <span class="k">{{ t("Output") }}</span>
              <span class="v">{{ formatTokens(usage.total.output) }}</span>
            </div>
            <div>
              <span class="k">{{ t("Cache hits") }}</span>
              <span class="v">{{ cacheHitPercent }}</span>
            </div>
          </div>

          <div :class="SECTION_H">{{ t("By model") }}</div>
          <div :class="rows()">
            <div v-if="modelRows.length === 0" class="[&_.mono]:min-w-0 [&_.mono]:flex-1 [&_.mono]:truncate [&_.mono]:text-xs" :class="rowClass({ size: 'sm' })">
              <span class="muted">{{ t("No calls yet") }}</span>
            </div>
            <div v-for="item in modelRows" :key="item.model" class="[&_.mono]:min-w-0 [&_.mono]:flex-1 [&_.mono]:truncate [&_.mono]:text-xs" :class="rowClass({ size: 'sm' })">
              <span class="mono">{{ item.model }}</span>
              <span class="hide-sm text-xs text-fg-subtle tabular-nums">
                {{
                  t("In {input} · Out {output}", {
                    input: formatTokens(item.summary.input),
                    output: formatTokens(item.summary.output),
                  })
                }}
                <template v-if="item.summary.cacheRead > 0">
                  · {{ t("Cache {tokens}", { tokens: formatTokens(item.summary.cacheRead) }) }}
                </template>
              </span>
              <span class="w-18 text-right tabular-nums">{{ formatCost(item.summary.cost) }}</span>
            </div>
          </div>

          <div :class="SECTION_H">{{ t("By conversation") }}</div>
          <div :class="PANEL">
            <table :class="TABLE">
              <tbody>
                <tr
                  v-for="row in conversationRows"
                  :key="row.id ?? 'router'"
                  :class="{ 'row-link': Boolean(row.id) }"
                  @click="row.id && $emit('open-ticket', row.id)"
                >
                  <td>
                    <span class="inline-flex max-w-full min-w-0 items-baseline gap-2 [&>.mono]:flex-none [&>.mono]:text-xs [&>.mono]:text-fg-subtle">
                      <span v-if="row.id" class="mono">{{ displayId(row.id) }}</span>
                      <span class="ellipsis">{{ row.title }}</span>
                    </span>
                  </td>
                  <td class="hide-sm w-[30%]">
                    <div class="h-1 overflow-hidden rounded-[2px] bg-(--ev-tray)"><i class="block h-full rounded-[2px] bg-(--ev-primary)" :style="{ width: barWidth(row.summary) }" /></div>
                  </td>
                  <td class="r w-24">{{ formatCost(row.summary.cost) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
