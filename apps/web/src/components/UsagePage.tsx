import { RefreshIcon } from "@earendil-works/elanor-icons-react";
import { Heading, IconButton, Table } from "@earendil-works/elanor-react";
import type { ProjectSummary, ProjectUsageResponse } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { formatCost, formatTokens } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
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
  const { t } = useI18n();
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
            aria-label={t("usage.refresh")}
            title={t("usage.refresh")}
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
              <span className="ev-stat-k">{t("usage.cost")}</span>
              <span className="ev-stat-v">{formatCost(totals.cost)}</span>
            </div>
            <div className="ev-stat-cell">
              <span className="ev-stat-k">{t("usage.input")}</span>
              <span className="ev-stat-v">{formatTokens(totals.input)}</span>
            </div>
            <div className="ev-stat-cell">
              <span className="ev-stat-k">{t("usage.output")}</span>
              <span className="ev-stat-v">{formatTokens(totals.output)}</span>
            </div>
            <div className="ev-stat-cell">
              <span className="ev-stat-k">{t("usage.cacheHit")}</span>
              <span className="ev-stat-v">{cacheHitPct}</span>
            </div>
          </div>

          <Heading level={2} size={6} style={{ margin: "4px 0 0" }}>
            {t("usage.byModel")}
          </Heading>

          {rows.length === 0 ? (
            <div style={{ fontSize: "0.8125rem", color: "var(--ev-fg-subtle)" }}>
              {loading ? t("common.loading") : t("usage.empty")}
            </div>
          ) : (
            <Table.Container className="ev-table-frame">
              <Table.Root>
                <Table.Head>
                  <Table.Row>
                    <Table.HeaderCell>{t("usage.col.model")}</Table.HeaderCell>
                    <Table.HeaderCell align="end">{t("usage.input")}</Table.HeaderCell>
                    <Table.HeaderCell align="end">{t("usage.output")}</Table.HeaderCell>
                    <Table.HeaderCell align="end">{t("usage.col.cache")}</Table.HeaderCell>
                    <Table.HeaderCell align="end">{t("usage.col.cost")}</Table.HeaderCell>
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
