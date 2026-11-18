<script setup lang="ts">
import type { Client } from "@shared/api/client.ts";
import type { ModelSpecView, ProjectSummary } from "@shared/api/contract.ts";
import { type ModelChoice, pickModel, type ThinkingLevel } from "@shared/contracts/index.ts";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { t } from "../i18n.ts";
import { listStep } from "../keyboard.ts";
import { levelLabel, levelsOf, sameModel, switchModel } from "../model-choice.ts";
import { useModelsView } from "../models-view.ts";
import { showToast } from "../toasts.ts";
import Icon from "./Icon.vue";
import LevelMenu from "./LevelMenu.vue";
import ModelMenu from "./ModelMenu.vue";

/**
 * The project Router's run configuration at the start of the composer's row: one button showing
 * `model · level`, a menu with a row for each, and the choices in a submenu beside the row. A choice
 * is the project's own (`project.json`); "默认" follows the settings again. Picking keeps the menu
 * open, so the model and the level can be set in one go.
 */
const props = defineProps<{ client: Client; project: ProjectSummary }>();
const emit = defineEmits<{ changed: [] }>();

const { view, load } = useModelsView(props.client);
onMounted(() => {
  if (view.value === undefined) void load();
});

const available = computed(() => view.value?.available ?? []);
const own = computed(() => props.project.models?.router);
const fallback = computed(() => pickModel("router", view.value?.defaults));
const effective = computed(() => own.value ?? fallback.value);
const levels = computed(() => levelsOf(available.value, effective.value));
const level = computed<ThinkingLevel>(() => effective.value?.thinkingLevel ?? "off");
const thinks = computed(() => levels.value.length > 1);

/** A model as people read it: its name from the catalog, else its id. */
function nameOf(choice: ModelChoice | undefined): string | undefined {
  if (choice === undefined) return undefined;
  return available.value.find((spec) => sameModel(spec, choice))?.name ?? choice.modelId;
}

type Row = "model" | "level";
const rows = computed<Row[]>(() => (thinks.value ? ["model", "level"] : ["model"]));

const root = ref<HTMLElement>();
const open = ref(false);
const sub = ref<Row>();
const busy = ref(false);

function focusRow(row: Row | undefined): void {
  void nextTick(() =>
    root.value?.querySelector<HTMLElement>(`[data-row="${row ?? rows.value[0]}"]`)?.focus(),
  );
}

function toggle(): void {
  open.value = !open.value;
  sub.value = undefined;
  if (open.value) focusRow(undefined);
}

function closeAll(): void {
  open.value = false;
  sub.value = undefined;
  void nextTick(() => root.value?.querySelector<HTMLElement>(".run-trigger")?.focus());
}

/** A submenu closed from the keyboard hands focus back to its row. */
function closeSub(): void {
  const row = sub.value;
  sub.value = undefined;
  focusRow(row);
}

function onMenuKeydown(event: KeyboardEvent): void {
  // Keys typed inside a submenu are its own.
  const row = (event.target as HTMLElement).dataset.row as Row | undefined;
  if (row === undefined) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeAll();
  } else if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    sub.value = row;
  } else {
    const next = listStep(event.key, rows.value.indexOf(row), rows.value.length);
    if (next === undefined) return;
    event.preventDefault();
    sub.value = undefined;
    focusRow(rows.value[next]);
  }
}

function onWindowDown(event: MouseEvent): void {
  if (!root.value?.contains(event.target as Node)) {
    open.value = false;
    sub.value = undefined;
  }
}
onMounted(() => window.addEventListener("mousedown", onWindowDown));
onUnmounted(() => window.removeEventListener("mousedown", onWindowDown));

async function save(model: ModelChoice | null): Promise<void> {
  busy.value = true;
  try {
    await props.client.call(
      "POST /api/projects/:project/models",
      { project: props.project.id },
      { role: "router", model },
    );
    emit("changed");
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy.value = false;
  }
}

function chooseModel(spec: ModelSpecView | null): void {
  void save(spec === null ? null : switchModel(effective.value, spec));
}

function chooseLevel(next: ThinkingLevel): void {
  const base = effective.value;
  if (base === undefined) return;
  void save({
    provider: base.provider,
    modelId: base.modelId,
    ...(next === "off" ? {} : { thinkingLevel: next }),
  });
}
</script>

<template>
  <div ref="root" class="run-config">
    <button
      type="button"
      class="run-trigger"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="t('运行设置')"
      :disabled="view === undefined"
      @click="toggle"
    >
      <Icon name="cpu" size="sm" />
      <span class="face-text">{{ nameOf(effective) ?? t("选择模型") }}</span>
      <template v-if="thinks">
        <span class="face-dot" aria-hidden="true">·</span>
        <span class="face-fixed">{{ levelLabel(level) }}</span>
      </template>
      <Icon name="chevD" size="xs" />
    </button>

    <div v-if="open" class="pop run-menu up" role="menu" :aria-label="t('运行设置')" @keydown="onMenuKeydown">
      <div class="run-item" @mouseenter="sub = 'model'">
        <button
          type="button"
          class="pop-row"
          :class="{ sel: sub === 'model' }"
          role="menuitem"
          data-row="model"
          aria-haspopup="listbox"
          :aria-expanded="sub === 'model'"
          @click="sub = 'model'"
        >
          <span>{{ t("模型") }}</span>
          <span class="run-value">{{ nameOf(effective) ?? t("未设置") }}</span>
          <Icon name="chevR" size="xs" />
        </button>
        <ModelMenu
          v-if="sub === 'model'"
          class="side"
          :models="available"
          :selected="own"
          :fallback="nameOf(fallback)"
          @pick="chooseModel"
          @close="closeSub"
        />
      </div>
      <div v-if="thinks" class="run-item" @mouseenter="sub = 'level'">
        <button
          type="button"
          class="pop-row"
          :class="{ sel: sub === 'level' }"
          role="menuitem"
          data-row="level"
          aria-haspopup="listbox"
          :aria-expanded="sub === 'level'"
          :disabled="busy"
          @click="sub = 'level'"
        >
          <span>{{ t("思考") }}</span>
          <span class="run-value">{{ levelLabel(level) }}</span>
          <Icon name="chevR" size="xs" />
        </button>
        <LevelMenu
          v-if="sub === 'level'"
          class="side"
          :levels="levels"
          :selected="level"
          @pick="chooseLevel"
          @close="closeSub"
        />
      </div>
    </div>
  </div>
</template>
