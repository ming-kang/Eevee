<script setup lang="ts">
import type { Client } from "@shared/protocol/client.ts";
import type { ModelSpecView, ProjectSummary } from "@shared/protocol/contract.ts";
import { type ModelChoice, pickModel, type ThinkingLevel } from "@shared/domain/index.ts";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { errorText } from "../../lib/errors.ts";
import { t } from "../../lib/i18n.ts";
import { listStep } from "../../lib/keyboard.ts";
import { levelLabel, levelsOf, sameModel, switchModel } from "../../lib/model-choice.ts";
import { useModelsView } from "../../composables/models-view.ts";
import { showToast } from "../../composables/toasts.ts";
import Icon from "../../ui/Icon.vue";
import LevelMenu from "./LevelMenu.vue";
import ModelMenu from "./ModelMenu.vue";
import { menuPanel, menuRow } from "../../ui/menu.ts";

/**
 * The project Router's run configuration at the start of the composer's row: one button showing
 * `model · level`, a menu with a row for each, and the choices in a submenu beside the row. A choice
 * is the project's own (`project.json`); "Default" follows the settings again. Picking keeps the menu
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
    showToast(errorText(err), "error");
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
  <div ref="root" class="relative -ml-1 min-w-0">
    <button
   type="button"
   class="inline-flex h-(--ev-h-sm) max-w-full min-w-0 items-center gap-1.5 rounded-sm px-2 text-sm font-normal whitespace-nowrap text-fg-muted transition-colors enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-45 aria-expanded:bg-hover aria-expanded:text-fg [&>.ico]:flex-none [&>.ico]:text-fg-subtle"
   aria-haspopup="menu"
   :aria-expanded="open"
   :aria-label="t('Run configuration')"
   :disabled="view === undefined"
   @click="toggle"
>
      <Icon name="cpu" size="sm" />
      <span class="min-w-0 truncate">{{ nameOf(effective) ?? t("Choose a model") }}</span>
      <template v-if="thinks">
        <span class="flex-none text-fg-subtle" aria-hidden="true">·</span>
        <span class="flex-none">{{ levelLabel(level) }}</span>
      </template>
      <Icon name="chevD" size="xs" />
    </button>

    <div v-if="open" class="bottom-[calc(100%_+_calc(6px*var(--ev-scale)))] left-0 min-w-60" :class="menuPanel()" role="menu" :aria-label="t('Run configuration')" @keydown="onMenuKeydown">
      <div class="relative" @mouseenter="sub = 'model'">
        <button
     type="button"
     
     :class="[menuRow('sm'), { sel: sub === 'model' }]"
     role="menuitem"
     data-row="model"
     aria-haspopup="listbox"
     :aria-expanded="sub === 'model'"
     @click="sub = 'model'"
>
          <span>{{ t("Model") }}</span>
          <span class="ml-auto max-w-40 min-w-0 truncate pl-4 text-fg-muted">{{ nameOf(effective) ?? t("Not set") }}</span>
          <Icon name="chevR" size="xs" />
        </button>
        <ModelMenu
          v-if="sub === 'model'"
          class="side -bottom-1 left-[calc(100%_+_calc(8px*var(--ev-scale)))]"
          :models="available"
          :selected="own"
          :fallback="nameOf(fallback)"
          @pick="chooseModel"
          @close="closeSub"
        />
      </div>
      <div v-if="thinks" class="relative" @mouseenter="sub = 'level'">
        <button
     type="button"
     
     :class="[menuRow('sm'), { sel: sub === 'level' }]"
     role="menuitem"
     data-row="level"
     aria-haspopup="listbox"
     :aria-expanded="sub === 'level'"
     :disabled="busy"
     @click="sub = 'level'"
>
          <span>{{ t("Thinking") }}</span>
          <span class="ml-auto max-w-40 min-w-0 truncate pl-4 text-fg-muted">{{ levelLabel(level) }}</span>
          <Icon name="chevR" size="xs" />
        </button>
        <LevelMenu
          v-if="sub === 'level'"
          class="side -bottom-1 left-[calc(100%_+_calc(8px*var(--ev-scale)))]"
          :levels="levels"
          :selected="level"
          @pick="chooseLevel"
          @close="closeSub"
        />
      </div>
    </div>
  </div>
</template>
