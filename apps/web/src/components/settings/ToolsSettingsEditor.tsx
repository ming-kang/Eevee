import { CheckIcon } from "@earendil-works/elanor-icons-react";
import { Button, Input, SegmentedControl } from "@earendil-works/elanor-react";
import {
  type CodemodeMode,
  ROUTER_TOGGLEABLE_TOOLS,
  type ToolsSettings,
  WORKER_TOGGLEABLE_TOOLS,
} from "@eevee/protocol";
import { useId } from "react";
import { type LocaleKey, useI18n } from "../../lib/i18n.ts";
import { EvTooltip } from "../EvTooltip.tsx";
import {
  cleanToolsSettings,
  defaultToolEnabled,
  hasToolsOverrides,
  resolveToolsSettings,
  type ToolRole,
  type ToolsEditorVariant,
  validateInlineBudgetInput,
} from "./tools-settings.ts";

export { hasToolsOverrides, resolveToolsSettings };

type ProjectCodemodeMode = CodemodeMode | "inherit";

type ToolsSettingsEditorProps = {
  readonly variant: ToolsEditorVariant;
  readonly value: ToolsSettings | undefined;
  readonly onChange: (value: ToolsSettings | undefined) => void;
  readonly inheritedTools?: ToolsSettings | undefined;
  readonly inlineBudget: string;
  readonly onInlineBudgetChange: (value: string) => void;
  readonly inlineBudgetError?: string;
  readonly disabled?: boolean;
};

const TOOL_DESC_KEYS: Readonly<Record<string, LocaleKey>> = {
  read: "tools.desc.read",
  write: "tools.desc.write",
  edit: "tools.desc.edit",
  bash: "tools.desc.bash",
  powershell: "tools.desc.powershell",
  tasks: "tools.desc.tasks",
  ls: "tools.desc.ls",
  find: "tools.desc.find",
  grep: "tools.desc.grep",
  tool_search: "tools.desc.tool_search",
};

function modeHintKey(mode: ProjectCodemodeMode): LocaleKey {
  if (mode === "inherit") return "tools.modeHint.inherit";
  if (mode === "off") return "tools.modeHint.off";
  if (mode === "only") return "tools.modeHint.only";
  return "tools.modeHint.on";
}

function ToolGrid({
  toolRole,
  label,
  tools,
  variant,
  value,
  inheritedTools,
  disabled,
  onToggle,
}: {
  readonly toolRole: ToolRole;
  readonly label: string;
  readonly tools: readonly string[];
  readonly variant: ToolsEditorVariant;
  readonly value: ToolsSettings | undefined;
  readonly inheritedTools: ToolsSettings | undefined;
  readonly disabled: boolean;
  readonly onToggle: (role: ToolRole, name: string) => void;
}) {
  const { t: translate } = useI18n();
  const states = tools.map((name) => {
    const ownValue = value?.[toolRole]?.[name];
    const inheritedValue = inheritedTools?.[toolRole]?.[name];
    const enabled = ownValue ?? inheritedValue ?? defaultToolEnabled(toolRole, name);
    const overridden = variant === "project" && ownValue !== undefined;
    return { name, enabled, overridden };
  });
  const enabledCount = states.filter((item) => item.enabled).length;

  return (
    <fieldset className="ev-tool-group" aria-label={label}>
      <div className="ev-tool-group-head">
        <span className="ev-tool-group-title">{label}</span>
        <span className="ev-tool-group-count ev-num">
          {enabledCount} / {tools.length}
        </span>
      </div>
      <div className="ev-tool-grid">
        {states.map(({ name, enabled, overridden }) => {
          const state = translate(enabled ? "common.enabled" : "common.disabled");
          const baseTitle = overridden
            ? translate("tools.chipOverriddenTitle", { name, state })
            : variant === "project"
              ? translate("tools.chipInheritedTitle", { name, state })
              : translate("tools.chipGlobalTitle", { name, state });
          const descKey = TOOL_DESC_KEYS[name];
          const tooltip = descKey ? `${baseTitle} · ${translate(descKey)}` : baseTitle;
          return (
            <EvTooltip key={name} content={tooltip} side="top">
              <button
                type="button"
                className="ev-tool-chip"
                data-active={enabled}
                data-overridden={overridden}
                aria-pressed={enabled}
                aria-label={baseTitle}
                disabled={disabled}
                onClick={() => onToggle(toolRole, name)}
              >
                <span className="ev-tool-chip-indicator" aria-hidden="true">
                  {enabled && <CheckIcon width={10} height={10} />}
                </span>
                <span className="ev-tool-chip-name">{name}</span>
                {overridden && <span className="ev-tool-override-dot" aria-hidden="true" />}
              </button>
            </EvTooltip>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ToolsSettingsEditor({
  variant,
  value,
  onChange,
  inheritedTools,
  inlineBudget,
  onInlineBudgetChange,
  inlineBudgetError,
  disabled = false,
}: ToolsSettingsEditorProps) {
  const { t: translate } = useI18n();
  const budgetId = useId();
  const project = variant === "project";
  const globalTools = inheritedTools ?? {};
  const ownMode = value?.codemode?.mode;
  const selectedMode: ProjectCodemodeMode = project ? (ownMode ?? "inherit") : (ownMode ?? "on");
  const effectiveMode = ownMode ?? globalTools.codemode?.mode ?? "on";
  const budgetPlaceholder = String(project ? (globalTools.codemode?.inlineBudget ?? 3000) : 3000);
  const effectiveBudgetError = inlineBudgetError ?? validateInlineBudgetInput(inlineBudget);
  const hasOverrides = hasToolsOverrides(value) || inlineBudget.trim().length > 0;
  const hasCodemodeOverride = ownMode !== undefined || inlineBudget.trim().length > 0;

  const toggleTool = (role: ToolRole, name: string) => {
    const overrides = { ...value?.[role] };
    const enabled = overrides[name] ?? globalTools[role]?.[name] ?? defaultToolEnabled(role, name);
    const nextEnabled = !enabled;
    if (!project && nextEnabled === defaultToolEnabled(role, name)) delete overrides[name];
    else overrides[name] = nextEnabled;
    onChange(cleanToolsSettings({ ...value, [role]: overrides }, !project));
  };

  const changeMode = (mode: ProjectCodemodeMode) => {
    const codemode = { ...value?.codemode };
    if (mode === "inherit" || (!project && mode === "on")) delete codemode.mode;
    else codemode.mode = mode;
    onChange(cleanToolsSettings({ ...value, codemode }, !project));
  };

  const resetOverrides = () => {
    onChange(undefined);
    onInlineBudgetChange("");
  };

  return (
    <div className="ev-tools-editor">
      <div className="ev-codemode-row">
        <div className="ev-tool-group ev-codemode-mode-col">
          <div className="ev-tool-group-head">
            <span className="ev-tool-group-title">{translate("tools.codemodeMode")}</span>
            {project && hasCodemodeOverride && (
              <span className="eevee-badge" data-tone="info">
                {translate("tools.projectOverrideBadge")}
              </span>
            )}
          </div>
          <SegmentedControl.Root
            className="ev-codemode-segments"
            density="compact"
            disabled={disabled}
            value={[selectedMode]}
            onValueChange={(values) => {
              const mode = values[0];
              if (
                mode === "off" ||
                mode === "on" ||
                mode === "only" ||
                (project && mode === "inherit")
              ) {
                changeMode(mode);
              }
            }}
          >
            {project && (
              <SegmentedControl.Item value="inherit">
                {translate("tools.mode.inherit")}
              </SegmentedControl.Item>
            )}
            <SegmentedControl.Item value="off">{translate("tools.mode.off")}</SegmentedControl.Item>
            <SegmentedControl.Item value="on">{translate("tools.mode.on")}</SegmentedControl.Item>
            <SegmentedControl.Item value="only">
              {translate("tools.mode.only")}
            </SegmentedControl.Item>
          </SegmentedControl.Root>
          <p className="ev-inline-hint">{translate(modeHintKey(selectedMode))}</p>
        </div>

        {effectiveMode !== "off" && (
          <div className="ev-inline-budget-field">
            <EvTooltip
              content={translate(
                project ? "tools.inlineBudgetProjectTitle" : "tools.inlineBudgetGlobalTitle",
              )}
              side="top"
            >
              <label htmlFor={budgetId} className="ev-tool-group-title ev-inline-budget-label">
                {translate("tools.inlineBudgetLabel")}
              </label>
            </EvTooltip>
            <div className="ev-unit-input">
              <Input
                id={budgetId}
                className="ev-unit-input-control"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={effectiveBudgetError ? true : undefined}
                value={inlineBudget}
                placeholder={budgetPlaceholder}
                disabled={disabled}
                onValueChange={onInlineBudgetChange}
              />
              <span className="ev-unit-suffix ev-mono" aria-hidden="true">
                tokens
              </span>
            </div>
            {effectiveBudgetError && <p className="ev-inline-error">{effectiveBudgetError}</p>}
          </div>
        )}
      </div>

      <ToolGrid
        toolRole="router"
        label={translate("tools.routerBuiltIn")}
        tools={ROUTER_TOGGLEABLE_TOOLS}
        variant={variant}
        value={value}
        inheritedTools={globalTools}
        disabled={disabled}
        onToggle={toggleTool}
      />
      <ToolGrid
        toolRole="worker"
        label={translate("tools.workerBuiltIn")}
        tools={WORKER_TOGGLEABLE_TOOLS}
        variant={variant}
        value={value}
        inheritedTools={globalTools}
        disabled={disabled}
        onToggle={toggleTool}
      />

      {hasOverrides && (
        <div className="ev-tools-editor-footer">
          <Button
            type="button"
            hierarchy="tertiary"
            density="compact"
            disabled={disabled}
            onClick={resetOverrides}
          >
            {translate("tools.resetToGlobal")}
          </Button>
        </div>
      )}
    </div>
  );
}
