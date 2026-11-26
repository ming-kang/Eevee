import { CheckIcon } from "@earendil-works/elanor-icons-react";
import { Button, Input, SegmentedControl } from "@earendil-works/elanor-react";
import {
  type CodemodeMode,
  ROUTER_TOGGLEABLE_TOOLS,
  type ToolsSettings,
  WORKER_DEFAULT_DISABLED_TOOLS,
  WORKER_TOGGLEABLE_TOOLS,
} from "@eevee/protocol";
import { useId } from "react";

type EditorVariant = "global" | "project";
type ToolRole = "router" | "worker";
type ProjectCodemodeMode = CodemodeMode | "inherit";

type ToolsSettingsEditorProps = {
  readonly variant: EditorVariant;
  readonly value: ToolsSettings | undefined;
  readonly onChange: (value: ToolsSettings | undefined) => void;
  readonly inheritedTools?: ToolsSettings | undefined;
  readonly inlineBudget: string;
  readonly onInlineBudgetChange: (value: string) => void;
  readonly disabled?: boolean;
};

function defaultToolEnabled(role: ToolRole, name: string): boolean {
  return role === "router" || !WORKER_DEFAULT_DISABLED_TOOLS.some((tool) => tool === name);
}

function isToggleableTool(role: ToolRole, name: string): boolean {
  const tools: readonly string[] =
    role === "router" ? ROUTER_TOGGLEABLE_TOOLS : WORKER_TOGGLEABLE_TOOLS;
  return tools.includes(name);
}

function cleanToolMap(
  role: ToolRole,
  overrides: Readonly<Record<string, boolean>> | undefined,
  global: boolean,
): Record<string, boolean> | undefined {
  if (!overrides) return undefined;
  const next: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(overrides)) {
    if (global && isToggleableTool(role, name) && enabled === defaultToolEnabled(role, name)) {
      continue;
    }
    next[name] = enabled;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function cleanToolsSettings(
  value: ToolsSettings | undefined,
  global: boolean,
): ToolsSettings | undefined {
  if (!value) return undefined;
  const router = cleanToolMap("router", value.router, global);
  const worker = cleanToolMap("worker", value.worker, global);
  const codemode =
    value.codemode && Object.keys(value.codemode).length > 0 ? { ...value.codemode } : undefined;
  if (!router && !worker && !codemode) return undefined;
  return {
    ...(router ? { router } : {}),
    ...(worker ? { worker } : {}),
    ...(codemode ? { codemode } : {}),
  };
}

export function hasToolsOverrides(value: ToolsSettings | undefined): boolean {
  if (!value) return false;
  return [value.router, value.worker, value.codemode].some(
    (section) => section !== undefined && Object.keys(section).length > 0,
  );
}

export function resolveToolsSettings(
  value: ToolsSettings | undefined,
  rawInlineBudget: string,
  variant: EditorVariant,
): ToolsSettings | undefined {
  const trimmed = rawInlineBudget.trim();
  let inlineBudget: number | undefined;
  if (trimmed) {
    if (!/^\d+$/.test(trimmed)) {
      throw new Error("inlineBudget 必须是非负整数。");
    }
    inlineBudget = Number(trimmed);
    if (!Number.isSafeInteger(inlineBudget)) {
      throw new Error("inlineBudget 必须是非负整数。");
    }
  }
  const codemode = { ...value?.codemode };
  if (inlineBudget === undefined) delete codemode.inlineBudget;
  else codemode.inlineBudget = inlineBudget;
  return cleanToolsSettings({ ...value, codemode }, variant === "global");
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
  readonly variant: EditorVariant;
  readonly value: ToolsSettings | undefined;
  readonly inheritedTools: ToolsSettings | undefined;
  readonly disabled: boolean;
  readonly onToggle: (role: ToolRole, name: string) => void;
}) {
  return (
    <fieldset className="ev-tool-group" aria-label={label}>
      <div className="ev-tool-group-head">
        <span className="ev-tool-group-title">{label}</span>
        {variant === "project" && <span className="ev-tool-group-hint">圆点表示项目覆盖</span>}
      </div>
      <div className="ev-tool-grid">
        {tools.map((name) => {
          const ownValue = value?.[toolRole]?.[name];
          const inheritedValue = inheritedTools?.[toolRole]?.[name];
          const enabled = ownValue ?? inheritedValue ?? defaultToolEnabled(toolRole, name);
          const overridden = variant === "project" && ownValue !== undefined;
          const stateLabel = enabled ? "已启用" : "已禁用";
          const title = overridden
            ? `${name}：${stateLabel}，项目覆盖`
            : variant === "project"
              ? `${name}：${stateLabel}，继承全局；点击创建项目覆盖`
              : `${name}：${stateLabel}`;
          return (
            <button
              key={name}
              type="button"
              className="ev-tool-chip"
              data-active={enabled}
              data-overridden={overridden}
              aria-pressed={enabled}
              aria-label={title}
              title={title}
              disabled={disabled}
              onClick={() => onToggle(toolRole, name)}
            >
              <span className="ev-tool-chip-check" aria-hidden="true">
                {enabled && <CheckIcon width={12} height={12} />}
              </span>
              <span>{name}</span>
              {overridden && <span className="ev-tool-override-dot" aria-hidden="true" />}
            </button>
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
  disabled = false,
}: ToolsSettingsEditorProps) {
  const budgetId = useId();
  const project = variant === "project";
  const globalTools = inheritedTools ?? {};
  const ownMode = value?.codemode?.mode;
  const selectedMode: ProjectCodemodeMode = project ? (ownMode ?? "inherit") : (ownMode ?? "on");
  const effectiveMode = ownMode ?? globalTools.codemode?.mode ?? "on";
  const budgetPlaceholder = String(project ? (globalTools.codemode?.inlineBudget ?? 3000) : 3000);
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
    if (mode === "inherit") delete codemode.mode;
    else codemode.mode = mode;
    onChange(cleanToolsSettings({ ...value, codemode }, !project));
  };

  const resetOverrides = () => {
    onChange(undefined);
    onInlineBudgetChange("");
  };

  return (
    <div className="ev-tools-editor">
      <div className="ev-tool-group">
        <div className="ev-tool-group-head">
          <span className="ev-tool-group-title">Codemode 模式</span>
          {project && hasCodemodeOverride && (
            <span className="eevee-badge" data-tone="info">
              项目覆盖
            </span>
          )}
        </div>
        <div className="ev-codemode-controls">
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
            {project && <SegmentedControl.Item value="inherit">继承全局</SegmentedControl.Item>}
            <SegmentedControl.Item value="off">关闭</SegmentedControl.Item>
            <SegmentedControl.Item value="on">开启</SegmentedControl.Item>
            <SegmentedControl.Item value="only">仅 Codemode</SegmentedControl.Item>
          </SegmentedControl.Root>
          {effectiveMode !== "off" && (
            <label
              htmlFor={budgetId}
              className="ev-inline-budget"
              title={project ? "留空以继承全局预算" : "留空使用默认预算 3000"}
            >
              <span className="ev-mono">inlineBudget</span>
              <Input
                id={budgetId}
                className="ev-inline-budget-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-label="Codemode inlineBudget"
                value={inlineBudget}
                placeholder={budgetPlaceholder}
                disabled={disabled}
                onValueChange={onInlineBudgetChange}
              />
            </label>
          )}
        </div>
      </div>

      <ToolGrid
        toolRole="router"
        label="Router 内置工具"
        tools={ROUTER_TOGGLEABLE_TOOLS}
        variant={variant}
        value={value}
        inheritedTools={globalTools}
        disabled={disabled}
        onToggle={toggleTool}
      />
      <ToolGrid
        toolRole="worker"
        label="Worker 内置工具"
        tools={WORKER_TOGGLEABLE_TOOLS}
        variant={variant}
        value={value}
        inheritedTools={globalTools}
        disabled={disabled}
        onToggle={toggleTool}
      />

      {project && (
        <div className="ev-tools-editor-footer">
          <span>未覆盖的设置自动跟随全局配置。</span>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            disabled={disabled || !hasOverrides}
            onClick={resetOverrides}
          >
            重置为继承全局
          </Button>
        </div>
      )}
    </div>
  );
}
