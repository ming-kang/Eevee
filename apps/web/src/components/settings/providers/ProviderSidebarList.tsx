import { SegmentedControl, Text } from "@earendil-works/elanor-react";
import type { ProviderSummary } from "@eevee/protocol";
import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../../lib/i18n.ts";
import { SearchField } from "../../SearchField.tsx";
import { formatAuthMeta, sortProvidersForSidebar } from "../provider-utils.ts";

export type ProviderCategoryFilter = "all" | "configured" | "custom" | "builtin";

export type ProviderSidebarListProps = {
  readonly providers: readonly ProviderSummary[];
  readonly filter: string;
  readonly onFilterChange: (value: string) => void;
  readonly category: ProviderCategoryFilter;
  readonly onCategoryChange: (value: ProviderCategoryFilter) => void;
  readonly selectedId: string | undefined;
  readonly onSelect: (providerId: string) => void;
};

export function ProviderSidebarList({
  providers,
  filter,
  onFilterChange,
  category,
  onCategoryChange,
  selectedId,
  onSelect,
}: ProviderSidebarListProps) {
  const { t } = useI18n();
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const query = filter.trim().toLowerCase();
  const visibleProviders = useMemo(
    () =>
      sortProvidersForSidebar(providers).filter((provider) => {
        if (category === "configured" && !provider.configured) return false;
        if (category === "custom" && provider.kind !== "custom") return false;
        if (category === "builtin" && provider.kind === "custom") return false;
        if (!query) return true;
        return `${provider.id} ${provider.name} ${provider.api ?? ""} ${provider.authAccountLabel ?? ""}`
          .toLowerCase()
          .includes(query);
      }),
    [providers, category, query],
  );

  const selectedIndex = selectedId
    ? visibleProviders.findIndex((provider) => provider.id === selectedId)
    : -1;

  useEffect(() => {
    if (selectedIndex < 0) return;
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div className="ev-provider-list-pane">
      <div className="ev-provider-filter-stack">
        <SearchField
          size="compact"
          value={filter}
          onChange={onFilterChange}
          placeholder={t("providers.sidebar.filterPlaceholder")}
          clearOnEscape
        />
        <SegmentedControl.Root
          className="ev-provider-category-filter"
          density="compact"
          value={[category]}
          onValueChange={(values) => {
            const next = values[0];
            if (
              next === "all" ||
              next === "configured" ||
              next === "custom" ||
              next === "builtin"
            ) {
              onCategoryChange(next);
            }
          }}
        >
          <SegmentedControl.Item value="all">{t("providers.sidebar.all")}</SegmentedControl.Item>
          <SegmentedControl.Item value="configured">
            {t("providers.sidebar.configured")}
          </SegmentedControl.Item>
          <SegmentedControl.Item value="custom">
            {t("providers.sidebar.custom")}
          </SegmentedControl.Item>
          <SegmentedControl.Item value="builtin">
            {t("providers.sidebar.builtin")}
          </SegmentedControl.Item>
        </SegmentedControl.Root>
      </div>

      <div className="ev-provider-list">
        {visibleProviders.length === 0 ? (
          <Text className="ev-inline-hint" style={{ padding: 12 }}>
            {t("providers.sidebar.empty")}
          </Text>
        ) : (
          visibleProviders.map((provider) => {
            const isCustom = provider.kind === "custom";
            return (
              <button
                type="button"
                key={provider.id}
                ref={provider.id === selectedId ? activeItemRef : undefined}
                className="ev-provider-item"
                data-active={provider.id === selectedId}
                title={provider.id}
                onClick={() => onSelect(provider.id)}
              >
                <div className="ev-provider-sidebar-head">
                  <span className="ev-dot" data-stage={provider.configured ? "done" : "idle"} />
                  <strong className="ev-truncate ev-flex-1">{provider.name}</strong>
                  <span className="ev-inline-muted ev-num">{provider.modelCount}</span>
                </div>
                <div className="ev-provider-item-badges">
                  <span className="ev-provider-item-meta ev-truncate">
                    {formatAuthMeta(provider, t)}
                  </span>
                  {isCustom && (
                    <span className="eevee-badge" data-tone="info">
                      {t("providers.badge.custom")}
                    </span>
                  )}
                  {!isCustom && provider.hasConfigOverride && (
                    <span className="eevee-badge" data-tone="warning">
                      {t("providers.badge.overridden")}
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
