<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import { computed, onMounted, ref, shallowRef } from "vue";
import ProjectView from "./components/ProjectView.vue";
import { usePolling } from "./polling.ts";
import { openSession } from "./session.ts";

const client = shallowRef<Client>();
const authError = ref<string>();
const selected = ref(localStorage.getItem("eevee.project") ?? "");

onMounted(async () => {
  try {
    client.value = await openSession();
  } catch (error) {
    authError.value = error instanceof Error ? error.message : String(error);
  }
});

const status = usePolling(async () => client.value?.call("GET /api/status"), 5000);
const projects = computed(() => status.data.value?.projects ?? []);
const current = computed(
  () => projects.value.find((p) => p.id === selected.value) ?? projects.value[0],
);

function select(id: string): void {
  selected.value = id;
  localStorage.setItem("eevee.project", id);
}
</script>

<template>
  <main v-if="authError" class="center"><p>{{ authError }}</p></main>
  <main v-else-if="!client" class="center"><p class="muted">正在连接 Engine…</p></main>
  <div v-else class="frame">
    <nav class="sidebar">
      <div class="brand">Eevee <span class="muted">{{ status.data.value?.version }}</span></div>
      <div class="section muted">项目</div>
      <button
        v-for="p in projects"
        :key="p.id"
        class="project"
        :class="{ active: p.id === current?.id }"
        :title="p.workspace"
        @click="select(p.id)"
      >
        {{ p.title }}
      </button>
      <p v-if="projects.length === 0" class="muted hint">
        还没有项目：<code>eevee project create &lt;标题&gt; -w &lt;目录&gt;</code>
      </p>
      <p v-if="status.error.value" class="error hint">{{ status.error.value }}</p>
    </nav>
    <ProjectView v-if="current" :key="current.id" :client="client" :project="current" />
    <main v-else class="center muted">选择或新建一个项目</main>
  </div>
</template>

<style scoped>
.frame {
  display: grid;
  grid-template-columns: var(--ev-sidebar-width) minmax(0, 1fr);
  height: 100%;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 16px 10px;
  background: var(--ev-bg-sidebar);
  border-right: 1px solid var(--ev-border);
  overflow-y: auto;
}

.brand {
  font-weight: 600;
  font-size: 16px;
  padding: 0 8px 12px;
}

.section {
  font-size: 12px;
  padding: 8px 8px 4px;
}

.project {
  text-align: left;
  border: none;
  background: transparent;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project.active {
  background: var(--ev-bg-hover);
  font-weight: 600;
}

.hint {
  padding: 0 8px;
  font-size: 12px;
}

@media (max-width: 768px) {
  .frame {
    grid-template-columns: minmax(0, 1fr);
  }
  .sidebar {
    display: none;
  }
}
</style>
