import { Input, Switch, Text } from "@earendil-works/elanor-react";
import type { ThinkingLevel, ThinkingLevelConfig } from "@eevee/protocol";
import { setThinkingRule, THINKING_LEVELS } from "./provider-utils.ts";

export function ThinkingLevelsEditor({
  value,
  onChange,
  reasoning,
  showInheritedBadges = false,
  disabled = false,
}: {
  readonly value: ThinkingLevelConfig;
  readonly onChange: (value: ThinkingLevelConfig) => void;
  readonly reasoning?: boolean;
  readonly showInheritedBadges?: boolean;
  readonly disabled?: boolean;
}) {
  const updateRule = (
    level: ThinkingLevel,
    patch: Partial<{ enabled: boolean; mappedTo: string }>,
  ) => {
    const current = value[level];
    const next = {
      enabled: patch.enabled ?? current.enabled,
      ...(patch.mappedTo === undefined
        ? current.mappedTo === undefined
          ? {}
          : { mappedTo: current.mappedTo }
        : patch.mappedTo.trim()
          ? { mappedTo: patch.mappedTo }
          : {}),
      inherited: false,
    };
    onChange(setThinkingRule(value, level, next));
  };

  return (
    <div className="ev-thinking-editor">
      <div className="ev-thinking-grid ev-thinking-grid-head" aria-hidden="true">
        <span>档位</span>
        <span>状态</span>
        <span>映射目标</span>
      </div>
      {THINKING_LEVELS.map((level) => {
        const rule = value[level];
        const extended = level === "xhigh" || level === "max";
        return (
          <div className="ev-thinking-grid" key={level}>
            <div className="ev-thinking-level">
              <span className="ev-mono">{level}</span>
              {showInheritedBadges && rule.inherited === false && (
                <span className="eevee-badge" data-tone="info">
                  已覆盖
                </span>
              )}
            </div>
            <div className="ev-thinking-toggle">
              <Switch.Root
                checked={rule.enabled}
                disabled={disabled}
                aria-label={`${level} ${rule.enabled ? "开启" : "关闭"}`}
                onCheckedChange={(checked) => updateRule(level, { enabled: checked })}
              >
                <Switch.Thumb />
              </Switch.Root>
              <span>{rule.enabled ? "开启" : "关闭"}</span>
            </div>
            <Input
              type="text"
              value={rule.mappedTo ?? ""}
              disabled={disabled || !rule.enabled}
              placeholder={extended ? `原档位 (${level})` : "协议默认"}
              aria-label={`${level} 映射目标`}
              onValueChange={(next) => updateRule(level, { mappedTo: next })}
            />
          </div>
        );
      })}
      {reasoning !== true && (
        <Text className="ev-inline-hint">
          该模型当前未启用推理；开启「支持推理」后，这些思考档位配置才会生效。
        </Text>
      )}
    </div>
  );
}
