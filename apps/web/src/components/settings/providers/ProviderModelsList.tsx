import {
  AddIcon,
  CloudDownloadIcon,
  EditIcon,
  ExperimentIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, Heading, KeyValue, SearchAndFilterBar, Text } from "@earendil-works/elanor-react";
import type { ProviderDetail } from "@eevee/protocol";
import { useState } from "react";
import { formatTokens } from "../../../lib/format.ts";
import { useI18n } from "../../../lib/i18n.ts";
import { EvTooltip } from "../../EvTooltip.tsx";
import { SearchField } from "../../SearchField.tsx";
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
          <span className="ev-num ev-heading-count">
            {detailModels.length === detail.models.length
              ? detail.models.length
              : `${detailModels.length} / ${detail.models.length}`}
          </span>
        </Heading>
        <SearchAndFilterBar.Root
          role="search"
          aria-label={t("providers.models.filterPlaceholder")}
          className="ev-inline-filter-bar"
        >
          <SearchAndFilterBar.Search className="ev-provider-model-search">
            <SearchField
              size="compact"
              value={modelFilter}
              onChange={setModelFilter}
              placeholder={t("providers.models.filterPlaceholder")}
              clearOnEscape
            />
          </SearchAndFilterBar.Search>
          <SearchAndFilterBar.Filters className="ev-provider-models-toolbar">
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
          </SearchAndFilterBar.Filters>
        </SearchAndFilterBar.Root>
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
                      {model.name !== model.id && (
                        <span className="ev-mono ev-inline-muted">{model.id}</span>
                      )}
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
                      {model.reasoning && (
                        <EvTooltip content={t("modelMenu.reasoningTooltip")} side="top">
                          <span className="eevee-badge">{t("modelMenu.reasoning")}</span>
                        </EvTooltip>
                      )}
                      {model.input.includes("image") && (
                        <EvTooltip content={t("modelMenu.visionTooltip")} side="top">
                          <span className="eevee-badge">{t("modelMenu.vision")}</span>
                        </EvTooltip>
                      )}
                    </div>
                    <div className="ev-provider-model-meta">
                      <KeyValue.Inline className="ev-kv-muted">
                        <KeyValue.Key>API</KeyValue.Key>
                        <KeyValue.Value className="ev-mono">{model.api}</KeyValue.Value>
                        <KeyValue.Key>Context</KeyValue.Key>
                        <KeyValue.Value className="ev-num">
                          {formatTokens(model.contextWindow)}
                        </KeyValue.Value>
                        <KeyValue.Key>Max Out</KeyValue.Key>
                        <KeyValue.Value className="ev-num">
                          {formatTokens(model.maxTokens)}
                        </KeyValue.Value>
                      </KeyValue.Inline>
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
