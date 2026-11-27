import { RefreshIcon } from "@earendil-works/elanor-icons-react";
import { Button, Heading, Input, Table } from "@earendil-works/elanor-react";
import type { ModelInfo } from "@eevee/protocol";
import { useState } from "react";
import { formatTokens } from "../../../lib/format.ts";

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
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const [filter, setFilter] = useState("");
  const [showAllModels, setShowAllModels] = useState(false);

  const scopedModels = onlyAvailable ? allModels.filter((m) => m.available) : allModels;
  const visibleModels = scopedModels.filter((m) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q);
  });
  const displayedModels = showAllModels ? visibleModels : visibleModels.slice(0, DISPLAY_LIMIT);

  return (
    <div className="ev-settings-section">
      <div className="ev-settings-head">
        <Heading level={2} size={5}>
          模型目录
          <span
            className="ev-num"
            style={{ marginLeft: 8, fontSize: 13, fontWeight: 400, color: "var(--ev-fg-subtle)" }}
          >
            {visibleModels.length}
          </span>
        </Heading>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ width: 220 }}>
            <Input type="text" value={filter} onValueChange={setFilter} placeholder="筛选模型…" />
          </div>
          <Button
            hierarchy="secondary"
            density="compact"
            onClick={() => setOnlyAvailable((prev) => !prev)}
          >
            {onlyAvailable ? "仅可用" : "全部"}
          </Button>
          <Button
            hierarchy="secondary"
            density="compact"
            iconStart={<RefreshIcon width={15} height={15} />}
            pending={refreshing}
            onClick={onRefresh}
          >
            刷新
          </Button>
        </div>
      </div>

      <Table.Container className="ev-table-frame">
        <Table.Root>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>模型</Table.HeaderCell>
              <Table.HeaderCell>思考档位</Table.HeaderCell>
              <Table.HeaderCell align="end">上下文</Table.HeaderCell>
              <Table.HeaderCell align="end">输出</Table.HeaderCell>
              <Table.HeaderCell align="end">状态</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {visibleModels.length === 0 ? (
              <Table.Row>
                <Table.Cell
                  colSpan={5}
                  style={{ color: "var(--ev-fg-subtle)", textAlign: "center", paddingBlock: 24 }}
                >
                  {onlyAvailable ? "无可用模型" : "无匹配模型"}
                </Table.Cell>
              </Table.Row>
            ) : (
              displayedModels.map((model) => (
                <Table.Row key={`${model.provider}/${model.id}`}>
                  <Table.Cell>
                    <div className="ev-model-cell">
                      <span className="ev-mono">
                        {model.provider}/{model.id}
                      </span>
                      {model.name !== model.id && (
                        <span className="ev-inline-muted" style={{ fontSize: 12 }}>
                          {model.name}
                        </span>
                      )}
                      <div className="ev-model-badges">
                        {model.isCustom && (
                          <span className="eevee-badge" data-tone="info">
                            自定义
                          </span>
                        )}
                        {!model.isCustom && model.hasOverride && (
                          <span className="eevee-badge" data-tone="warning">
                            已覆盖
                          </span>
                        )}
                        {model.input?.includes("image") && (
                          <span className="eevee-badge">image</span>
                        )}
                        {model.reasoning && <span className="eevee-badge">reasoning</span>}
                      </div>
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
                      data-tone={model.available ? "positive" : "neutral"}
                    >
                      {model.available ? "可用" : "未认证"}
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
              ? `已显示全部 ${visibleModels.length} 个模型`
              : `当前显示前 ${DISPLAY_LIMIT} 个，共 ${visibleModels.length} 个模型`}
          </span>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            onClick={() => setShowAllModels((prev) => !prev)}
          >
            {showAllModels
              ? `收起为前 ${DISPLAY_LIMIT} 个`
              : `显示全部 ${visibleModels.length} 个模型`}
          </Button>
        </div>
      )}
    </div>
  );
}
