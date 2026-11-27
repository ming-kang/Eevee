import { RefreshIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  PageHeader,
  SearchAndFilterBar,
  Section,
  SegmentedControl,
  Table,
} from "@earendil-works/elanor-react";
import type { ModelInfo } from "@eevee/protocol";
import { useState } from "react";
import { formatTokens } from "../../../lib/format.ts";
import { useI18n } from "../../../lib/i18n.ts";
import { SearchField } from "../../SearchField.tsx";

const DISPLAY_LIMIT = 100;

export type ModelCatalogSectionProps = {
  readonly allModels: readonly ModelInfo[];
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
};

export function ModelCatalogSection({
  allModels,
  refreshing,
  onRefresh,
}: ModelCatalogSectionProps) {
  const { t } = useI18n();
  const [scope, setScope] = useState<"available" | "all">("available");
  const [filter, setFilter] = useState("");
  const [showAllModels, setShowAllModels] = useState(false);

  const scopedModels = scope === "available" ? allModels.filter((m) => m.available) : allModels;
  const visibleModels = scopedModels.filter((m) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q);
  });
  const displayedModels = showAllModels ? visibleModels : visibleModels.slice(0, DISPLAY_LIMIT);

  return (
    <Section.Root className="ev-settings-section">
      <PageHeader.Root className="ev-section-header">
        <PageHeader.Row>
          <PageHeader.Title level={2} className="ev-section-title">
            {t("models.catalogTitle")}
            <span className="ev-num ev-heading-count">{visibleModels.length}</span>
          </PageHeader.Title>
          <PageHeader.Actions>
            <SearchAndFilterBar.Root
              role="search"
              aria-label={t("models.filterPlaceholder")}
              className="ev-inline-filter-bar"
            >
              <SearchAndFilterBar.Search className="ev-catalog-search">
                <SearchField
                  size="compact"
                  value={filter}
                  onChange={setFilter}
                  placeholder={t("models.filterPlaceholder")}
                  clearOnEscape
                />
              </SearchAndFilterBar.Search>
              <SearchAndFilterBar.Filters className="ev-catalog-toolbar">
                <SegmentedControl.Root
                  density="compact"
                  value={[scope]}
                  onValueChange={(vals) => {
                    const next = vals[0];
                    if (next === "available" || next === "all") setScope(next);
                  }}
                >
                  <SegmentedControl.Item value="available">
                    {t("models.onlyAvailable")}
                  </SegmentedControl.Item>
                  <SegmentedControl.Item value="all">{t("models.all")}</SegmentedControl.Item>
                </SegmentedControl.Root>
                <Button
                  hierarchy="secondary"
                  density="compact"
                  iconStart={<RefreshIcon width={15} height={15} />}
                  pending={refreshing}
                  onClick={onRefresh}
                >
                  {t("common.refresh")}
                </Button>
              </SearchAndFilterBar.Filters>
            </SearchAndFilterBar.Root>
          </PageHeader.Actions>
        </PageHeader.Row>
      </PageHeader.Root>

      <Table.Container className="ev-table-frame">
        <Table.Root>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>{t("models.col.model")}</Table.HeaderCell>
              <Table.HeaderCell>{t("models.col.thinking")}</Table.HeaderCell>
              <Table.HeaderCell align="end">{t("models.col.context")}</Table.HeaderCell>
              <Table.HeaderCell align="end">{t("models.col.output")}</Table.HeaderCell>
              <Table.HeaderCell align="end">{t("models.col.status")}</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {visibleModels.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={5} className="ev-table-empty">
                  {t(scope === "available" ? "models.emptyAvailable" : "models.emptyMatch")}
                </Table.Cell>
              </Table.Row>
            ) : (
              displayedModels.map((model) => (
                <Table.Row key={`${model.provider}/${model.id}`}>
                  <Table.Cell>
                    <div className="ev-model-cell">
                      <div className="ev-model-badges">
                        <span className="ev-mono">
                          {model.provider}/{model.id}
                        </span>
                        {model.isCustom && (
                          <span className="eevee-badge" data-tone="info">
                            {t("models.badge.custom")}
                          </span>
                        )}
                        {!model.isCustom && model.hasOverride && (
                          <span className="eevee-badge" data-tone="warning">
                            {t("models.badge.overridden")}
                          </span>
                        )}
                        {model.input?.includes("image") && (
                          <span className="eevee-badge">image</span>
                        )}
                        {model.reasoning && <span className="eevee-badge">reasoning</span>}
                      </div>
                      {model.name !== model.id && (
                        <span className="ev-inline-muted">{model.name}</span>
                      )}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    {model.supportedThinkingLevels && model.supportedThinkingLevels.length > 0 ? (
                      <div className="ev-thinking-pills">
                        {model.supportedThinkingLevels.map((level) => (
                          <span key={level} className="ev-thinking-pill ev-mono">
                            {level}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="ev-inline-muted">—</span>
                    )}
                  </Table.Cell>
                  <Table.Cell align="end" className="ev-num">
                    {formatTokens(model.contextWindow)}
                  </Table.Cell>
                  <Table.Cell align="end" className="ev-num">
                    {formatTokens(model.maxTokens)}
                  </Table.Cell>
                  <Table.Cell align="end">
                    <span
                      className="eevee-badge"
                      data-tone={model.available ? "positive" : undefined}
                    >
                      {t(
                        model.available
                          ? "models.status.available"
                          : "models.status.unauthenticated",
                      )}
                    </span>
                  </Table.Cell>
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table.Root>
      </Table.Container>

      {visibleModels.length > DISPLAY_LIMIT && (
        <div className="ev-table-footer">
          <span className="ev-inline-muted ev-num">
            {showAllModels
              ? t("models.showingAll", { count: visibleModels.length })
              : t("models.showingLimited", { limit: DISPLAY_LIMIT, count: visibleModels.length })}
          </span>
          <Button
            hierarchy="tertiary"
            density="compact"
            onClick={() => setShowAllModels((prev) => !prev)}
          >
            {showAllModels
              ? t("models.collapseToLimit", { limit: DISPLAY_LIMIT })
              : t("models.showAll", { count: visibleModels.length })}
          </Button>
        </div>
      )}
    </Section.Root>
  );
}
