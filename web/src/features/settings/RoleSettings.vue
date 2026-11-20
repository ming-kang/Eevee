<script setup lang="ts">
import type { CapabilitiesView } from "@shared/protocol/contract.ts";
import type { RoleName } from "@shared/domain/index.ts";
import { computed, ref, watch } from "vue";
import type { IconName } from "../../composables/icons.ts";
import { t } from "../../lib/i18n.ts";
import { EXPOSURE_LABEL, ROLE_LABEL } from "../../lib/labels.ts";
import { formatRoute } from "../../lib/router.ts";
import { showToast } from "../../composables/toasts.ts";
import Icon from "../../ui/Icon.vue";
import Button from "../../ui/Button.vue";
import Input from "../../ui/Input.vue";
import Switch from "../../ui/Switch.vue";
import Segmented from "../../ui/Segmented.vue";
import { PANEL, badge } from "../../ui/surface.ts";
import { ROW_DESC, row as rowClass, rowMain, rowTitle } from "../../ui/rows.ts";

const props = defineProps<{
  capabilities: CapabilitiesView;
  busy: boolean;
}>();

const emit = defineEmits<{
  toggle: [role: RoleName, extension: string];
  "max-turns": [role: RoleName, value: number | null];
}>();

const MCP_HREF = formatRoute({ name: "settings", section: "mcp" });

const ROLE_DESC: Record<RoleName, string> = {
  router: t("Plans the work, dispatches tickets, reviews reports and keeps memory"),
  worker: t("Carries out one ticket with files, commands and background jobs"),
  dreamer: t("Tidies project memory in the background"),
};

/** What a built-in extension does, in the reader's words; its raw name stays on the tooltip. */
const BUILT_IN: Record<string, string> = {
  "eevee.resources": t("Read addresses"),
  "eevee.dispatch": t("Tickets & questions"),
  "eevee.memory": t("Memory"),
  "eevee.router": t("Handoff"),
  "eevee.workspace": t("Files & commands"),
  "eevee.report": t("Reports"),
  "eevee.memory-project": t("Project memory"),
};
const builtInLabel = (name: string): string => BUILT_IN[name] ?? name.replace(/^eevee\./, "");

const HELPER_DESC: Record<string, string> = {
  "tool-search": t("Finds deferred MCP tools when they are needed"),
  codemode: t("Runs scripts that call several tools at once"),
};

const selected = ref<RoleName>("router");
const roles = computed(() => props.capabilities.roles);
const role = computed(() => roles.value.find((r) => r.role === selected.value));

const mcpServers = computed(() => new Map(props.capabilities.mcp.map((m) => [m.extension, m])));

const mcpExtensions = computed(() =>
  props.capabilities.available.filter((ext) => ext.name.startsWith("mcp.")),
);

const helperExtensions = computed(() =>
  props.capabilities.available.filter((ext) => !ext.name.startsWith("mcp.")),
);

/** Extensions the selected role still enables though nothing installed answers to them. */
const uninstalled = computed(() => {
  const installed = new Set(props.capabilities.available.map((ext) => ext.name));
  return (role.value?.enabled ?? []).filter((name) => !installed.has(name));
});

const enabled = (name: string): boolean => role.value?.enabled.includes(name) ?? false;
const serverOf = (extName: string) => mcpServers.value.get(extName);
const serverName = (extName: string): string =>
  serverOf(extName)?.name ?? extName.replace(/^mcp\./, "");
const mcpFailed = (extName: string): boolean => serverOf(extName)?.state === "failed";

/** An MCP row's second line: how many tools it offers and how they reach the model. */
function mcpLine(ext: { name: string; tools: number }): string {
  const server = serverOf(ext.name);
  const parts = [t("{n} tool|{n} tools", { n: ext.tools })];
  if (server) parts.push(EXPOSURE_LABEL[server.exposure].label);
  return parts.join(" · ");
}

/** One extension row: raw `name` toggles and labels the switch; `label` is what the reader sees. */
type ExtRow = {
  name: string;
  label: string;
  icon: IconName;
  /** The second line; an uninstalled or failed entry carries `error` in bad ink as well. */
  detail?: string;
  error?: string;
  dot?: boolean;
};

/** Installed `mcp.*` extensions, then enabled-but-uninstalled ones so a removed server still shows here. */
const mcpRows = computed<ExtRow[]>(() => [
  ...mcpExtensions.value.map(
    (ext): ExtRow => ({
      name: ext.name,
      label: serverName(ext.name),
      icon: "plug",
      detail: mcpLine(ext),
      error: mcpFailed(ext.name) ? t("The MCP server failed to connect") : undefined,
      dot: mcpFailed(ext.name),
    }),
  ),
  ...uninstalled.value
    .filter((name) => name.startsWith("mcp."))
    .map(
      (name): ExtRow => ({
        name,
        label: name.replace(/^mcp\./, ""),
        icon: "plug",
        error: t("Not installed"),
      }),
    ),
]);

/** Other installed extensions (tool-search, codemode), then enabled-but-uninstalled non-MCP names. */
const helperRows = computed<ExtRow[]>(() => [
  ...helperExtensions.value.map(
    (ext): ExtRow => ({
      name: ext.name,
      label: ext.name,
      icon: "puzzle",
      detail: HELPER_DESC[ext.name] ?? t("{n} tool|{n} tools", { n: ext.tools }),
    }),
  ),
  ...uninstalled.value
    .filter((name) => !name.startsWith("mcp."))
    .map(
      (name): ExtRow => ({
        name,
        label: name,
        icon: "puzzle",
        error: t("Not installed"),
      }),
    ),
]);

type ExtSection = {
  key: string;
  title: string;
  hint?: string;
  rows: ExtRow[];
  /** Empty-state text when the role has no entries at all; MCP also offers a link to add one. */
  empty?: string;
};

const extSections = computed<ExtSection[]>(() => {
  const sections: ExtSection[] = [
    { key: "mcp", title: t("MCP servers"), rows: mcpRows.value, empty: t("No MCP servers") },
  ];
  if (helperRows.value.length > 0) {
    sections.push({
      key: "helpers",
      title: t("Tool helpers"),
      hint: t(
        "Roles get these automatically when an MCP server's exposure needs them; turn one on to always include it",
      ),
      rows: helperRows.value,
    });
  }
  return sections;
});

const turnDrafts = ref<Record<RoleName, string>>({ router: "", worker: "", dreamer: "" });
watch(
  () => props.capabilities,
  (cap) => {
    const next = { router: "", worker: "", dreamer: "" } as Record<RoleName, string>;
    for (const r of cap.roles) {
      next[r.role] = r.maxTurns !== undefined ? String(r.maxTurns) : "";
    }
    turnDrafts.value = next;
  },
  { immediate: true },
);

function commitTurns(): void {
  const current = role.value;
  if (!current || props.busy) return;
  const raw = (turnDrafts.value[current.role] ?? "").trim();
  const value = raw === "" ? null : Number(raw);
  if (value !== null && (!Number.isInteger(value) || value < 1)) {
    showToast(t("Turn limit must be a positive whole number, or empty for the default"), "error");
    turnDrafts.value[current.role] =
      current.maxTurns !== undefined ? String(current.maxTurns) : "";
    return;
  }
  if ((current.maxTurns ?? null) === value) return;
  emit("max-turns", current.role, value);
}
</script>

<template>
  <Segmented v-model="selected" mode="tabs" size="md" class="self-start [&_.n]:text-(length:--ev-caption) [&_.n]:text-fg-subtle [&_.n]:tabular-nums" id-prefix="role-tab" controls="role-panel" :options="roles.map((item) => ({ value: item.role, label: ROLE_LABEL[item.role] }))" :label="t('Roles')">
    <template #default="{ option, index }">
      <span>{{ option.label }}</span>
      <span v-if="(roles[index]?.enabled.length ?? 0) > 0" class="n">{{ roles[index]?.enabled.length }}</span>
    </template>
  </Segmented>

  <div v-if="role" id="role-panel" class="[&>*+*]:border-t [&>*+*]:border-separator" :class="PANEL" role="tabpanel" :aria-labelledby="`role-tab-${role.role}`">
    <div :class="rowClass()">
      <div :class="rowMain()">
        <span :class="ROW_DESC">{{ ROLE_DESC[role.role] }}</span>
      </div>
    </div>

    <div :class="rowClass()">
      <div :class="rowMain()">
        <span :class="rowTitle()">{{ t("Built in") }}</span>
        <span class="flex flex-wrap gap-1">
          <span v-for="name in role.builtIn" :key="name" :class="badge()" :title="name">
            {{ builtInLabel(name) }}
          </span>
        </span>
        <span :class="ROW_DESC">{{ t("Always on") }}</span>
      </div>
    </div>

    <template v-for="section in extSections" :key="section.key">
      <div :class="rowClass({ size: 'sect' })">
        <div :class="rowMain()">
          <span :class="rowTitle({ muted: true })">{{ section.title }}</span>
          <span v-if="section.hint" :class="ROW_DESC">{{ section.hint }}</span>
        </div>
      </div>
      <div v-for="row in section.rows" :key="row.name" :class="rowClass()">
        <Icon :name="row.icon" size="sm" class="dim" />
        <div :class="rowMain()">
          <span :class="rowTitle()">
            <span class="mono">{{ row.label }}</span>
            <span v-if="row.dot" class="dot bad" />
          </span>
          <span v-if="row.detail" :class="ROW_DESC">{{ row.detail }}</span>
          <span v-if="row.error" class="err" :class="ROW_DESC">{{ row.error }}</span>
        </div>
        <Switch :model-value="enabled(row.name)" :disabled="busy" :aria-label="
            t('{role} uses {extension}', { role: ROLE_LABEL[role.role], extension: row.name })
          " @update:model-value="emit('toggle', role.role, row.name)" />
      </div>
      <div v-if="section.rows.length === 0 && section.empty" :class="rowClass()">
        <div :class="rowMain()">
          <span :class="ROW_DESC">{{ section.empty }}</span>
        </div>
        <Button size="sm" :href="MCP_HREF">{{ t("Add one in MCP & extensions") }}</Button>
      </div>
    </template>

    <div :class="rowClass()">
      <label :class="rowMain()" :for="`turn-limit-${role.role}`">
        <span :class="rowTitle()">{{ t("Turn limit") }}</span>
      </label>
      <Input :id="`turn-limit-${role.role}`" v-model="turnDrafts[role.role]" mono inline class="w-19 text-center" inputmode="numeric" :placeholder="t('Default')" :aria-label="t('{role} turn limit', { role: ROLE_LABEL[role.role] })" :disabled="busy" @change="commitTurns" />
    </div>
  </div>
</template>
