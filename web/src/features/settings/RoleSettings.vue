<script setup lang="ts">
import type { CapabilitiesView } from "@shared/api/contract.ts";
import type { RoleName } from "@shared/contracts/index.ts";
import { computed, ref, watch } from "vue";
import { vSeg } from "../dom.ts";
import { onRovingKeydown } from "../focus.ts";
import type { IconName } from "../icons.ts";
import { t } from "../i18n.ts";
import { EXPOSURE_LABEL, ROLE_LABEL } from "../labels.ts";
import { formatRoute } from "../router.ts";
import { showToast } from "../toasts.ts";
import Icon from "./Icon.vue";

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
  /** A failed server's dot beside the label. */
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
  <div
    v-seg
    class="seg role-seg"
    role="tablist"
    :aria-label="t('Roles')"
    @keydown="
      onRovingKeydown(
        $event,
        roles.map((r) => r.role),
        selected,
        (key) => (selected = key),
      )
    "
  >
    <button
      v-for="item in roles"
      :id="`role-tab-${item.role}`"
      :key="item.role"
      type="button"
      role="tab"
      aria-controls="role-panel"
      :aria-selected="selected === item.role"
      :tabindex="selected === item.role ? 0 : -1"
      :class="{ on: selected === item.role }"
      @click="selected = item.role"
    >
      <span>{{ ROLE_LABEL[item.role] }}</span>
      <span v-if="item.enabled.length > 0" class="n">{{ item.enabled.length }}</span>
    </button>
  </div>

  <div v-if="role" id="role-panel" class="panel" role="tabpanel" :aria-labelledby="`role-tab-${role.role}`">
    <div class="row">
      <div class="r-main">
        <span class="r-d">{{ ROLE_DESC[role.role] }}</span>
      </div>
    </div>

    <div class="row">
      <div class="r-main">
        <span class="r-t">{{ t("Built in") }}</span>
        <span class="r-chips">
          <span v-for="name in role.builtIn" :key="name" class="chip" :title="name">
            {{ builtInLabel(name) }}
          </span>
        </span>
        <span class="r-d">{{ t("Always on") }}</span>
      </div>
    </div>

    <template v-for="section in extSections" :key="section.key">
      <div class="row sect">
        <div class="r-main">
          <span class="r-t">{{ section.title }}</span>
          <span v-if="section.hint" class="r-d">{{ section.hint }}</span>
        </div>
      </div>
      <div v-for="row in section.rows" :key="row.name" class="row">
        <Icon :name="row.icon" size="sm" class="dim" />
        <div class="r-main">
          <span class="r-t">
            <span class="mono">{{ row.label }}</span>
            <span v-if="row.dot" class="dot bad" />
          </span>
          <span v-if="row.detail" class="r-d">{{ row.detail }}</span>
          <span v-if="row.error" class="r-d err">{{ row.error }}</span>
        </div>
        <button
          type="button"
          class="switch"
          :class="{ on: enabled(row.name) }"
          :disabled="busy"
          :aria-pressed="enabled(row.name)"
          :aria-label="
            t('{role} uses {extension}', { role: ROLE_LABEL[role.role], extension: row.name })
          "
          @click="emit('toggle', role.role, row.name)"
        />
      </div>
      <div v-if="section.rows.length === 0 && section.empty" class="row">
        <div class="r-main">
          <span class="r-d">{{ section.empty }}</span>
        </div>
        <a class="btn sm" :href="MCP_HREF">{{ t("Add one in MCP & extensions") }}</a>
      </div>
    </template>

    <div class="row">
      <label class="r-main" :for="`turn-limit-${role.role}`">
        <span class="r-t">{{ t("Turn limit") }}</span>
      </label>
      <input
        :id="`turn-limit-${role.role}`"
        v-model="turnDrafts[role.role]"
        class="input mono turns"
        inputmode="numeric"
        :placeholder="t('Default')"
        :aria-label="t('{role} turn limit', { role: ROLE_LABEL[role.role] })"
        :disabled="busy"
        @change="commitTurns"
      />
    </div>
  </div>
</template>
