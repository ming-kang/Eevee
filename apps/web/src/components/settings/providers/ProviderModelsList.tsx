import {
  AddIcon,
  CloudDownloadIcon,
  EditIcon,
  ExperimentIcon,
  SearchIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, Heading, Text } from "@earendil-works/elanor-react";
import type { ProviderDetail } from "@eevee/protocol";
import { useState } from "react";
import { formatTokens } from "../../../lib/format.ts";
import { useI18n } from "../../../lib/i18n.ts";
import type { ModelEditorTarget } from "../model-editor/state.ts";
import { SmokeTestResult } from "../SmokeTestResult.tsx";
import { modelSmokeKey, useModelSmokeTests } from "../useModelSmokeTests.ts";

export type ProviderModelsListProps = {
  readonly detail: ProviderDetail;
  readonly onOpenProbe: (providerId: string) => void;
  readonly onAddModel: (target: ModelEditorTarget) => void;
  readonly onEditModel: (target: ModelEditorTarget) => void;
};

export function ProviderModelsList({
  detail,
  onOpenProbe,
  onAddModel,
  onEditModel,
}: ProviderModelsListProps) {
  const { t } = useI18n();
  const [modelFilter, setModelFilter] = useState("");
  const { tests: modelTests, runTest, cancelTest } = useModelSmokeTests();

  const query = modelFilter.trim().toLowerCase();
  const detailModels = query
    ? detail.models.filter((model) =>
        `${model.id} ${model.name} ${model.api}`.toLowerCase().includes(query),
      )
    : detail.models;

  return (
    <div className="ev-settings-card">
      <div className="ev-settings-head">
        <Heading level={3} size={6}>
          {t("providers.models.title")}
          <span
            className="ev-num"
            style={{
              marginLeft: 8,
              fontSize: 12.5,
              fontWeight: 400,
              color: "var(--ev-fg-subtle)",
            }}
          >
            {detailModels.length === detail.models.length
              ? detail.models.length
              : `${detailModels.length} / ${detail.models.length}`}
          </span>
        </Heading>
        <div className="ev-provider-models-toolbar">
          <div className="ev-probe-search" style={{ minWidth: 160 }}>
            <SearchIcon width={14} height={14} />
            <input
              className="ev-raw-input"
              value={modelFilter}
              placeholder={t("providers.models.filterPlaceholder")}
              onChange={(event) => setModelFilter(event.target.value)}
            />
          </div>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<CloudDownloadIcon width={14} height={14} />}
            onClick={() => onOpenProbe(detail.id)}
          >
            {t("providers.models.probeAndImport")}
          </Button>
          <Button
            type="button"
            hierarchy="primary"
            density="compact"
            iconStart={<AddIcon width={14} height={14} />}
            onClick={() =>
              onAddModel({
                providerId: detail.id,
                providerApi: detail.config?.api ?? detail.api ?? detail.models[0]?.api,
                providerBaseUrl: detail.baseUrl,
              })
            }
          >
            {t("providers.models.addModel")}
          </Button>
        </div>
      </div>

      {detailModels.length === 0 ? (
        <Text className="ev-inline-hint">
          {detail.models.length === 0
            ? t("providers.models.emptyProvider")
            : t("providers.models.emptyFiltered")}
        </Text>
      ) : (
        <div className="ev-provider-model-list">
          {detailModels.map((model) => {
            const testKey = modelSmokeKey(detail.id, model.id);
            const smoke = modelTests[testKey];
            return (
              <div key={model.id} className="ev-provider-model-row">
                <div className="ev-provider-model-top">
                  <div className="ev-provider-model-main">
                    <div className="ev-provider-item-head">
                      <span className="ev-dot" data-stage={model.available ? "done" : "idle"} />
                      <strong>{model.name}</strong>
                      <span className="ev-mono ev-inline-muted">{model.id}</span>
                      {model.isCustom && (
                        <span className="eevee-badge" data-tone="info">
                          {t("providers.badge.custom")}
                        </span>
                      )}
                      {!model.isCustom && model.hasOverride && (
                        <span className="eevee-badge" data-tone="warning">
                          {t("providers.badge.overridden")}
                        </span>
                      )}
                      {model.reasoning && <span className="eevee-badge">reasoning</span>}
                      {model.input.includes("image") && <span className="eevee-badge">image</span>}
                    </div>
                    <div className="ev-provider-model-meta">
                      <span className="ev-mono">{model.api}</span>
                      <span className="ev-num">
                        {t("providers.models.contextWindow", {
                          tokens: formatTokens(model.contextWindow),
                        })}
                      </span>
                      <span className="ev-num">
                        {t("providers.models.maxTokens", {
                          tokens: formatTokens(model.maxTokens),
                        })}
                      </span>
                      {model.supportedThinkingLevels.length > 0 && (
                        <span className="ev-thinking-pills">
                          {model.supportedThinkingLevels.map((level) => (
                            <span key={level} className="ev-thinking-pill ev-mono">
                              {level}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="ev-provider-model-actions">
                    <Button
                      type="button"
                      hierarchy="secondary"
                      density="compact"
                      iconStart={<ExperimentIcon width={14} height={14} />}
                      pending={smoke?.loading === true}
                      onClick={() => void runTest(detail.id, model.id)}
                    >
                      {t("providers.models.test")}
                    </Button>
                    <Button
                      type="button"
                      hierarchy="secondary"
                      density="compact"
                      iconStart={<EditIcon width={14} height={14} />}
                      onClick={() =>
                        onEditModel({
                          providerId: detail.id,
                          providerApi: detail.config?.api ?? detail.api ?? model.api,
                          providerBaseUrl: detail.baseUrl,
                          model,
                        })
                      }
                    >
                      {t("common.edit")}
                    </Button>
                  </div>
                </div>

                {smoke && !smoke.loading && (smoke.result || smoke.error) && (
                  <div className="ev-profile-smoke">
                    {smoke.error && <div className="ev-error-banner">{smoke.error}</div>}
                    {smoke.result && <SmokeTestResult result={smoke.result} />}
                    <div>
                      <Button
                        type="button"
                        hierarchy="tertiary"
                        density="compact"
                        onClick={() => cancelTest(testKey)}
                      >
                        {t("providers.models.hideResult")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
