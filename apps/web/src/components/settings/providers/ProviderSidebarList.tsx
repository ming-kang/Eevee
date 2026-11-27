import { SearchIcon } from "@earendil-works/elanor-icons-react";
import { SegmentedControl, Text } from "@earendil-works/elanor-react";
import type { ProviderSummary } from "@eevee/protocol";
import { formatAuthMeta } from "../provider-utils.ts";

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
  const query = filter.trim().toLowerCase();
  const visibleProviders = providers.filter((provider) => {
    if (category === "configured" && !provider.configured) return false;
    if (category === "custom" && provider.kind !== "custom") return false;
    if (category === "builtin" && provider.kind === "custom") return false;
    if (!query) return true;
    return `${provider.id} ${provider.name} ${provider.api ?? ""} ${provider.authAccountLabel ?? ""}`
      .toLowerCase()
      .includes(query);
  });

  return (
    <div className="ev-provider-list-pane">
      <div className="ev-provider-filter-stack">
        <div className="ev-probe-search">
          <SearchIcon width={14} height={14} />
          <input
            className="ev-raw-input"
            value={filter}
            placeholder="筛选 Provider…"
            onChange={(event) => onFilterChange(event.target.value)}
          />
        </div>
        <SegmentedControl.Root
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
          <SegmentedControl.Item value="all">全部</SegmentedControl.Item>
          <SegmentedControl.Item value="configured">已配置</SegmentedControl.Item>
          <SegmentedControl.Item value="custom">自定义</SegmentedControl.Item>
          <SegmentedControl.Item value="builtin">内置</SegmentedControl.Item>
        </SegmentedControl.Root>
      </div>

      <div className="ev-provider-list">
        {visibleProviders.length === 0 ? (
          <Text className="ev-inline-hint" style={{ padding: 12 }}>
            没有匹配的 Provider。
          </Text>
        ) : (
          visibleProviders.map((provider) => {
            const isCustom = provider.kind === "custom";
            return (
              <button
                type="button"
                key={provider.id}
                className="ev-provider-item"
                data-active={provider.id === selectedId}
                onClick={() => onSelect(provider.id)}
              >
                <div className="ev-provider-item-head">
                  <span className="ev-dot" data-stage={provider.configured ? "done" : "idle"} />
                  <strong className="ev-truncate">{provider.name}</strong>
                  <span className="ev-mono ev-inline-muted ev-truncate">{provider.id}</span>
                </div>
                <div className="ev-provider-item-badges">
                  <span className="eevee-badge" data-tone={isCustom ? "info" : "neutral"}>
                    {isCustom ? "自定义" : "内置"}
                  </span>
                  {!isCustom && provider.hasConfigOverride && (
                    <span className="eevee-badge" data-tone="warning">
                      已覆盖
                    </span>
                  )}
                  <span className="ev-inline-muted ev-num">{provider.modelCount} 模型</span>
                </div>
                <div className="ev-provider-item-meta ev-truncate">{formatAuthMeta(provider)}</div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
