import { Input, Switch } from "@earendil-works/elanor-react";
import { THINKING_LEVELS, type ThinkingLevel, type ThinkingLevelConfig } from "@eevee/protocol";
import { useI18n } from "../../lib/i18n.ts";
import { setThinkingRule } from "./provider-utils.ts";

export function ThinkingLevelsEditor({
  value,
  onChange,
  showInheritedBadges = false,
  disabled = false,
}: {
  readonly value: ThinkingLevelConfig;
  readonly onChange: (value: ThinkingLevelConfig) => void;
  readonly showInheritedBadges?: boolean;
  readonly disabled?: boolean;
}) {
  const { t } = useI18n();
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
        <span>{t("thinking.col.level")}</span>
        <span>{t("thinking.col.status")}</span>
        <span>{t("thinking.col.mappedTo")}</span>
      </div>
      {THINKING_LEVELS.map((level) => {
        const rule = value[level];
        const extended = level === "xhigh" || level === "max";
        const stateText = rule.enabled ? t("thinking.on") : t("thinking.off");
        return (
          <div className="ev-thinking-grid" key={level}>
            <div className="ev-thinking-level">
              <span className="ev-mono">{level}</span>
              {showInheritedBadges && rule.inherited === false && (
                <span className="eevee-badge" data-tone="info">
                  {t("thinking.overridden")}
                </span>
              )}
            </div>
            <div className="ev-thinking-toggle">
              <Switch.Root
                checked={rule.enabled}
                disabled={disabled}
                aria-label={t("thinking.toggleAria", { level, state: stateText })}
                onCheckedChange={(checked) => updateRule(level, { enabled: checked })}
              >
                <Switch.Thumb />
              </Switch.Root>
              <span>{stateText}</span>
            </div>
            <Input
              type="text"
              value={rule.mappedTo ?? ""}
              disabled={disabled || !rule.enabled}
              placeholder={
                extended
                  ? t("thinking.originalLevelPlaceholder", { level })
                  : t("thinking.protocolDefault")
              }
              aria-label={t("thinking.mappedTargetAria", { level })}
              onValueChange={(next) => updateRule(level, { mappedTo: next })}
            />
          </div>
        );
      })}
    </div>
  );
}
