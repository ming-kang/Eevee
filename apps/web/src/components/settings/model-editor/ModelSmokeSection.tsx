import { ExperimentIcon } from "@earendil-works/elanor-icons-react";
import { Button, SegmentedControl, Switch } from "@earendil-works/elanor-react";
import type { ThinkingLevel } from "@eevee/protocol";
import { useId } from "react";
import { useI18n } from "../../../lib/i18n.ts";
import { EvTooltip } from "../../EvTooltip.tsx";
import { SmokeTestResult } from "../SmokeTestResult.tsx";
import type { ModelSmokeState } from "../useModelSmokeTests.ts";

export type ModelSmokeSectionProps = {
  readonly thinkingLevels: readonly ThinkingLevel[];
  readonly selectedLevel: ThinkingLevel | undefined;
  readonly onSelectLevel: (level: ThinkingLevel) => void;
  readonly testTools: boolean;
  readonly onToggleTestTools: (enabled: boolean) => void;
  readonly hasUnsavedChanges: boolean;
  readonly smoke: ModelSmokeState | undefined;
  readonly onRun: () => void;
  readonly onCancel: () => void;
};

export function ModelSmokeSection({
  thinkingLevels,
  selectedLevel,
  onSelectLevel,
  testTools,
  onToggleTestTools,
  hasUnsavedChanges,
  smoke,
  onRun,
  onCancel,
}: ModelSmokeSectionProps) {
  const { t } = useI18n();
  const toolsSwitchId = useId();
  const loading = smoke?.loading === true;

  return (
    <section className="ev-editor-section">
      <div className="ev-editor-section-head">
        <div className="ev-smoke-head-title">
          <div className="ev-editor-section-title">{t("modelEditor.smokeSection")}</div>
          {hasUnsavedChanges && (
            <span className="eevee-badge" data-tone="muted">
              {t("modelEditor.smokeSavedHint")}
            </span>
          )}
        </div>
        <div className="ev-inline-actions">
          {loading && (
            <Button type="button" hierarchy="tertiary" density="compact" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          )}
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<ExperimentIcon width={14} height={14} />}
            pending={loading}
            onClick={onRun}
          >
            {loading ? t("modelEditor.smokeTesting") : t("modelEditor.smokeTestButton")}
          </Button>
        </div>
      </div>

      <div className="ev-smoke-options">
        {thinkingLevels.length > 0 && selectedLevel && (
          <div className="ev-smoke-option">
            <span className="ev-smoke-option-label">Thinking</span>
            <SegmentedControl.Root
              density="compact"
              className="ev-smoke-thinking-segments"
              aria-label="Thinking"
              disabled={loading}
              value={[selectedLevel]}
              onValueChange={(values) => {
                const next = values[0];
                if (next) onSelectLevel(next as ThinkingLevel);
              }}
            >
              {thinkingLevels.map((level) => (
                <SegmentedControl.Item key={level} value={level}>
                  {level}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
          </div>
        )}
        <EvTooltip content={t("modelEditor.smokeTestToolsHint")} side="top">
          <div className="ev-smoke-switch-row">
            <Switch.Root
              id={toolsSwitchId}
              checked={testTools}
              disabled={loading}
              onCheckedChange={onToggleTestTools}
            >
              <Switch.Thumb />
            </Switch.Root>
            <label htmlFor={toolsSwitchId} className="ev-smoke-switch-label">
              {t("modelEditor.smokeTestTools")}
            </label>
          </div>
        </EvTooltip>
      </div>

      {smoke?.error && <div className="ev-error-banner">{smoke.error}</div>}
      {smoke?.result && <SmokeTestResult result={smoke.result} request={smoke.request} />}
    </section>
  );
}
