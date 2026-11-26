import { RefreshIcon } from "@earendil-works/elanor-icons-react";
import { Heading, IconButton, Table } from "@earendil-works/elanor-react";
import type { ProjectSummary, ProjectUsageResponse } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { formatCost, formatTokens } from "../lib/format.ts";
import { ProjectHeader } from "./ProjectHeader.tsx";

export function UsagePage({
  project,
  onSelectView,
  onEditProject,
}: {
  readonly project: ProjectSummary;
  readonly onSelectView: (view: "chat" | "memory" | "usage") => void;
  readonly onEditProject: () => void;
}) {
  const [usage, setUsage] = useState<ProjectUsageResponse | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setUsage(await api.getProjectUsage(project.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = Object.entries(usage?.usage.models ?? {})
    .map(([model, stats]) => ({ model, stats }))
    .sort(
      (a, b) =>
        b.stats.cost.total - a.stats.cost.total || b.stats.totalTokens - a.stats.totalTokens,
    );

  const totals = rows.reduce(
    (acc, r) => ({
      cost: acc.cost + r.stats.cost.total,
      input: acc.input + r.stats.input,
      output: acc.output + r.stats.output,
      cacheRead: acc.cacheRead + r.stats.cacheRead,
    }),
    { cost: 0, input: 0, output: 0, cacheRead: 0 },
  );

  const cacheHitPct =
    totals.input + totals.cacheRead > 0
      ? `${Math.round((totals.cacheRead / (totals.input + totals.cacheRead)) * 100)}%`
      : "0%";

  return (
    <section style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <ProjectHeader
        project={project}
        view="usage"
        onSelectView={onSelectView}
        onEditProject={onEditProject}
        actions={
          <IconButton
            aria-label="刷新用量"
            title="刷新用量"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshIcon width={16} height={16} />
          </IconButton>
        }
      />

      <div className="ev-page-scroll">
        <div className="ev-page-narrow">
          {error && <div className="ev-error-banner">{error}</div>}

          <div className="ev-stat-grid">
            <div className="ev-stat-cell">
              <span className="ev-stat-k">估算费用</span>
              <span className="ev-stat-v">{formatCost(totals.cost)}</span>
            </div>
            <div className="ev-stat-cell">
              <span className="ev-stat-k">Input</span>
              <span className="ev-stat-v">{formatTokens(totals.input)}</span>
            </div>
            <div className="ev-stat-cell">
              <span className="ev-stat-k">Output</span>
              <span className="ev-stat-v">{formatTokens(totals.output)}</span>
            </div>
            <div className="ev-stat-cell">
              <span className="ev-stat-k">缓存命中率</span>
              <span className="ev-stat-v">{cacheHitPct}</span>
            </div>
          </div>

          <Heading level={2} size={6} style={{ margin: "4px 0 0" }}>
            按模型
          </Heading>

          {rows.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--ev-fg-subtle)" }}>
              {loading ? "加载中…" : "暂无记录"}
            </div>
          ) : (
            <Table.Container className="ev-table-frame">
              <Table.Root>
                <Table.Head>
                  <Table.Row>
                    <Table.HeaderCell>模型</Table.HeaderCell>
                    <Table.HeaderCell align="end">Input</Table.HeaderCell>
                    <Table.HeaderCell align="end">Output</Table.HeaderCell>
                    <Table.HeaderCell align="end">Cache</Table.HeaderCell>
                    <Table.HeaderCell align="end">费用</Table.HeaderCell>
                  </Table.Row>
                </Table.Head>
                <Table.Body>
                  {rows.map(({ model, stats }) => (
                    <Table.Row key={model}>
                      <Table.Cell>
                        <span className="ev-mono">{model}</span>
                      </Table.Cell>
                      <Table.Cell align="end" className="ev-num">
                        {formatTokens(stats.input)}
                      </Table.Cell>
                      <Table.Cell align="end" className="ev-num">
                        {formatTokens(stats.output)}
                      </Table.Cell>
                      <Table.Cell align="end" className="ev-num">
                        {formatTokens(stats.cacheRead)}
                      </Table.Cell>
                      <Table.Cell align="end" className="ev-num">
                        {formatCost(stats.cost.total)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Table.Container>
          )}
        </div>
      </div>
    </section>
  );
}
