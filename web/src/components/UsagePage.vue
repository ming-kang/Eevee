<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { ProjectSummary, UsageSummary, UsageView } from "@shared/api/contract.ts";
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";

const props = defineProps<{
  client: Client;
  project: ProjectSummary;
}>();

defineEmits<{
  "open-side": [];
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
    error.value = err instanceof Error ? err.message : String(err);
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
    { title: "Router 主对话", summary: usage.value.router },
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
      <button type="button" class="btn ghost sm icon menu-btn" aria-label="菜单" @click="$emit('open-side')">
        <Icon name="menu" size="sm" />
      </button>
      <h1>花费</h1>
      <span class="sub ellipsis hide-sm">{{ project.title }}</span>
      <span class="spacer" />
      <button type="button" class="btn ghost sm icon" :disabled="loading" aria-label="刷新" title="刷新" @click="loadUsage">
        <Icon name="refresh" size="sm" :spin="loading" />
      </button>
    </header>
    <div class="page">
      <div class="page-inner">
        <p v-if="error" class="error hint">{{ error }}</p>
        <Skeleton v-else-if="loading && !usage" />
        <template v-else-if="usage">
          <div class="panel stats">
            <div title="按 provider 账单计，缺失时按目录价估算">
              <span class="k">总花费</span>
              <span class="v">{{ formatCost(usage.total.cost) }}</span>
            </div>
            <div>
              <span class="k">输入</span>
              <span class="v">{{ formatTokens(usage.total.input) }}</span>
            </div>
            <div>
              <span class="k">输出</span>
              <span class="v">{{ formatTokens(usage.total.output) }}</span>
            </div>
            <div>
              <span class="k">缓存命中</span>
              <span class="v">{{ cacheHitPercent }}</span>
            </div>
          </div>

          <div class="section-h">按模型</div>
          <div class="rows">
            <div v-if="modelRows.length === 0" class="row usage-row">
              <span class="muted">没有调用记录</span>
            </div>
            <div v-for="item in modelRows" :key="item.model" class="row usage-row">
              <span class="mono">{{ item.model }}</span>
              <span class="tokens hide-sm">
                入 {{ formatTokens(item.summary.input) }} · 出 {{ formatTokens(item.summary.output) }}
                <template v-if="item.summary.cacheRead > 0">
                  · 缓存 {{ formatTokens(item.summary.cacheRead) }}
                </template>
              </span>
              <span class="cost">{{ formatCost(item.summary.cost) }}</span>
            </div>
          </div>

          <div class="section-h">按对话</div>
          <div class="panel">
            <table class="table">
              <tbody>
                <tr
                  v-for="row in conversationRows"
                  :key="row.id ?? 'router'"
                  :class="{ 'row-link': Boolean(row.id) }"
                  @click="row.id && $emit('open-ticket', row.id)"
                >
                  <td>
                    <span class="conv-title">
                      <span v-if="row.id" class="mono">{{ row.id }}</span>
                      <span class="ellipsis">{{ row.title }}</span>
                    </span>
                  </td>
                  <td class="hide-sm bar-cell">
                    <div class="inbar"><i :style="{ width: barWidth(row.summary) }" /></div>
                  </td>
                  <td class="r cost-cell">{{ formatCost(row.summary.cost) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
