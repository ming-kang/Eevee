import { SearchIcon } from "@earendil-works/elanor-icons-react";
import { Button, Text } from "@earendil-works/elanor-react";
import type { ProbedModel } from "@eevee/protocol";
import type { ReactNode } from "react";
import { formatTokens } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import { filterProbedModels } from "./provider-utils.ts";

export type ModelProbeSelectorProps = {
  readonly models: readonly ProbedModel[];
  readonly selected: Readonly<Record<string, boolean>>;
  readonly onSelectedChange: (next: Record<string, boolean>) => void;
  readonly filter: string;
  readonly onFilterChange: (filter: string) => void;
  readonly filterPlaceholder?: string;
  readonly emptyText?: string;
  readonly variant?: "list" | "chips";
  readonly loading?: boolean;
  readonly suppressEmpty?: boolean;
  readonly toolbarActions?: ReactNode;
  readonly statusSlot?: ReactNode;
};

function formatProbeModelMeta(model: ProbedModel, existsSuffix: string): string {
  const parts: string[] = [];
  if (model.contextWindow !== undefined) parts.push(formatTokens(model.contextWindow));
  if (model.reasoning === true) parts.push("reasoning");
  if (model.input?.includes("image") === true) parts.push("image");
  if (model.exists) parts.push(existsSuffix.replace(/^\s*·\s*/, ""));
  return parts.join(" · ");
}

export function ModelProbeSelector({
  models,
  selected,
  onSelectedChange,
  filter,
  onFilterChange,
  filterPlaceholder,
  emptyText,
  variant = "list",
  loading = false,
  suppressEmpty = false,
  toolbarActions,
  statusSlot,
}: ModelProbeSelectorProps) {
  const { t } = useI18n();
  const resolvedFilterPlaceholder = filterPlaceholder ?? t("probe.filterPlaceholder");
  const resolvedEmptyText = emptyText ?? t("probe.empty");
  const visibleModels = filterProbedModels(models, filter);
  const selectedCount = models.reduce(
    (count, model) => (selected[model.id] === true ? count + 1 : count),
    0,
  );

  const toggleModel = (modelId: string, checked: boolean) => {
    onSelectedChange({ ...selected, [modelId]: checked });
  };

  const toggleAllVisible = (checked: boolean) => {
    const next = { ...selected };
    for (const model of visibleModels) {
      next[model.id] = checked;
    }
    onSelectedChange(next);
  };

  return (
    <div className="ev-probe-section">
      <div className="ev-probe-toolbar">
        <div className="ev-probe-search">
          <SearchIcon width={14} height={14} />
          <input
            className="ev-raw-input"
            value={filter}
            placeholder={resolvedFilterPlaceholder}
            onChange={(event) => onFilterChange(event.target.value)}
          />
        </div>
        {models.length > 0 && (
          <>
            <span className="eevee-badge ev-num">
              {t("probe.selectedCount", { selected: selectedCount, total: models.length })}
            </span>
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              onClick={() => toggleAllVisible(true)}
            >
              {t("probe.selectAllVisible")}
            </Button>
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              onClick={() => toggleAllVisible(false)}
            >
              {t("probe.deselectAllVisible")}
            </Button>
          </>
        )}
        {toolbarActions}
      </div>

      {statusSlot}

      {!loading && visibleModels.length === 0 && !suppressEmpty && (
        <Text className="ev-inline-hint">{resolvedEmptyText}</Text>
      )}

      {visibleModels.length > 0 &&
        (variant === "chips" ? (
          <div className="ev-probe-chip-grid">
            {visibleModels.map((model) => {
              const checked = selected[model.id] === true;
              const meta = formatProbeModelMeta(model, t("probe.existsSuffix"));
              return (
                <button
                  type="button"
                  key={model.id}
                  className="ev-probe-chip"
                  data-active={checked}
                  aria-pressed={checked}
                  onClick={() => toggleModel(model.id, !checked)}
                >
                  <span className="ev-probe-chip-title ev-mono">{model.id}</span>
                  {meta && <span className="ev-probe-chip-meta">{meta}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="ev-probe-list">
            {visibleModels.map((model) => {
              const checked = selected[model.id] === true;
              const meta = formatProbeModelMeta(model, t("probe.existsSuffix"));
              return (
                <label key={model.id} className="ev-probe-row" data-active={checked}>
                  <input
                    type="checkbox"
                    className="ev-native-checkbox"
                    checked={checked}
                    onChange={(event) => toggleModel(model.id, event.target.checked)}
                  />
                  <span className="ev-mono ev-truncate">{model.id}</span>
                  {model.name && model.name !== model.id && (
                    <span className="ev-inline-muted ev-truncate">{model.name}</span>
                  )}
                  {meta && <span className="ev-probe-row-meta ev-num">{meta}</span>}
                </label>
              );
            })}
          </div>
        ))}
    </div>
  );
}
