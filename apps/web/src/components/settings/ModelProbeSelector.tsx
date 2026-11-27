import { SearchIcon } from "@earendil-works/elanor-icons-react";
import { Button, Text } from "@earendil-works/elanor-react";
import type { ProbedModel } from "@eevee/protocol";
import type { ReactNode } from "react";
import { formatTokens } from "../../lib/format.ts";
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

export function ModelProbeSelector({
  models,
  selected,
  onSelectedChange,
  filter,
  onFilterChange,
  filterPlaceholder = "筛选探测结果…",
  emptyText = "没有可导入的模型。",
  variant = "list",
  loading = false,
  suppressEmpty = false,
  toolbarActions,
  statusSlot,
}: ModelProbeSelectorProps) {
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
            placeholder={filterPlaceholder}
            onChange={(event) => onFilterChange(event.target.value)}
          />
        </div>
        {models.length > 0 && (
          <>
            <span className="eevee-badge ev-num">
              已选 {selectedCount} / {models.length}
            </span>
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              onClick={() => toggleAllVisible(true)}
            >
              全选可见
            </Button>
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              onClick={() => toggleAllVisible(false)}
            >
              全不选
            </Button>
          </>
        )}
        {toolbarActions}
      </div>

      {statusSlot}

      {!loading && visibleModels.length === 0 && !suppressEmpty && (
        <Text className="ev-inline-hint">{emptyText}</Text>
      )}

      {visibleModels.length > 0 &&
        (variant === "chips" ? (
          <div className="ev-probe-chip-grid">
            {visibleModels.map((model) => {
              const checked = selected[model.id] === true;
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
                  <span className="ev-probe-chip-meta">
                    {model.contextWindow !== undefined && formatTokens(model.contextWindow)}
                    {model.reasoning === true && " · reasoning"}
                    {model.input?.includes("image") === true && " · image"}
                    {model.exists && " · 已存在"}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="ev-probe-list">
            {visibleModels.map((model) => {
              const checked = selected[model.id] === true;
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
                  <span className="ev-probe-row-meta ev-num">
                    {model.contextWindow !== undefined && formatTokens(model.contextWindow)}
                    {model.reasoning === true && " · reasoning"}
                    {model.input?.includes("image") === true && " · image"}
                    {model.exists && " · 已存在"}
                  </span>
                </label>
              );
            })}
          </div>
        ))}
    </div>
  );
}
