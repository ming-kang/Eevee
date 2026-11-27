import { RefreshIcon } from "@earendil-works/elanor-icons-react";
import {
  Heading,
  IconButton,
  Meter,
  Section,
  SegmentedControl,
  Skeleton,
  SkeletonText,
  Table,
} from "@earendil-works/elanor-react";
import type { ProjectSummary, ProjectUsageResponse } from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { formatCost, formatTokens } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import {
  buildDailySeries,
  buildHeatmapGrid,
  buildMonthlySeries,
  type HeatmapCell,
  type UsageBarSeriesPoint,
} from "../lib/usage-charts.ts";
import { useAbortableAsync } from "../lib/useAbortableAsync.ts";
import { EvTooltip } from "./EvTooltip.tsx";
import { ProjectHeader } from "./ProjectHeader.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";

function UsageStackedBarChart({
  points,
  ariaLabel,
}: {
  readonly points: readonly UsageBarSeriesPoint[];
  readonly ariaLabel: string;
}) {
  const { t } = useI18n();
  const [hoveredKey, setHoveredKey] = useState<string | undefined>(undefined);
  const maxVal = useMemo(
    () => Math.max(1, ...points.map((p) => p.input + p.output + p.cacheRead)),
    [points],
  );
  const hovered = points.find((p) => p.key === hoveredKey);

  const chartH = 148;
  const barAreaH = 118;
  const topPad = 8;
  const count = Math.max(1, points.length);
  const viewW = count * 36;

  return (
    <div className="ev-chart-box">
      <div className="ev-chart-legend">
        <span className="ev-chart-legend-item">
          <i className="ev-chart-swatch" data-series="input" />
          <span>{t("usage.input")}</span>
        </span>
        <span className="ev-chart-legend-item">
          <i className="ev-chart-swatch" data-series="output" />
          <span>{t("usage.output")}</span>
        </span>
        <span className="ev-chart-legend-item">
          <i className="ev-chart-swatch" data-series="cache" />
          <span>{t("usage.col.cache")}</span>
        </span>
        {hovered && (
          <span className="ev-chart-readout ev-mono ev-num">
            {hovered.key} ·{" "}
            {t("usage.tooltipTurns", {
              turns: hovered.turns,
              tokens: formatTokens(hovered.totalTokens),
              cost: formatCost(hovered.cost),
            })}
          </span>
        )}
      </div>

      <svg
        className="ev-usage-svg"
        viewBox={`0 0 ${viewW} ${chartH}`}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
        onMouseLeave={() => setHoveredKey(undefined)}
      >
        {[0.25, 0.5, 0.75, 1].map((frac) => {
          const y = topPad + barAreaH * (1 - frac);
          return <line key={frac} x1={0} x2={viewW} y1={y} y2={y} className="ev-chart-gridline" />;
        })}

        {points.map((pt, idx) => {
          const x = idx * 36 + 7;
          const barW = 22;
          const total = pt.input + pt.output + pt.cacheRead;
          const hCache = total > 0 ? (pt.cacheRead / maxVal) * barAreaH : 0;
          const hInput = total > 0 ? (pt.input / maxVal) * barAreaH : 0;
          const hOutput = total > 0 ? (pt.output / maxVal) * barAreaH : 0;
          const baseY = topPad + barAreaH;
          const yCache = baseY - hCache;
          const yInput = yCache - hInput;
          const yOutput = yInput - hOutput;
          const showLabel = points.length <= 8 || idx % 2 === 0 || idx === points.length - 1;

          return (
            <g
              key={pt.key}
              className="ev-chart-col"
              data-hovered={hoveredKey === pt.key || undefined}
            >
              <a
                href={`#usage-${pt.key}`}
                aria-label={`${pt.key}: ${formatTokens(pt.totalTokens)}`}
                onClick={(event) => event.preventDefault()}
                onMouseEnter={() => setHoveredKey(pt.key)}
                onFocus={() => setHoveredKey(pt.key)}
                onBlur={() => setHoveredKey(undefined)}
              >
                <rect x={idx * 36} y={0} width={36} height={chartH} fill="transparent" />
              </a>
              {hCache > 0 && (
                <rect
                  x={x}
                  y={yCache}
                  width={barW}
                  height={Math.max(1.5, hCache)}
                  rx={2}
                  className="ev-chart-bar-cache"
                />
              )}
              {hInput > 0 && (
                <rect
                  x={x}
                  y={yInput}
                  width={barW}
                  height={Math.max(1.5, hInput)}
                  rx={2}
                  className="ev-chart-bar-input"
                />
              )}
              {hOutput > 0 && (
                <rect
                  x={x}
                  y={yOutput}
                  width={barW}
                  height={Math.max(1.5, hOutput)}
                  rx={2}
                  className="ev-chart-bar-output"
                />
              )}
              {showLabel && (
                <text
                  x={x + barW / 2}
                  y={chartH - 5}
                  textAnchor="middle"
                  className="ev-chart-axis-label"
                >
                  {pt.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function UsageActivityHeatmap({ cells }: { readonly cells: readonly HeatmapCell[] }) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState<HeatmapCell | undefined>(undefined);
  const maxWeek = useMemo(() => cells.reduce((m, c) => Math.max(m, c.weekIndex), 0), [cells]);
  const cellSize = 12;
  const gap = 3;
  const step = cellSize + gap;
  const svgW = (maxWeek + 1) * step;
  const svgH = 7 * step;

  return (
    <div className="ev-heatmap-box">
      <div className="ev-heatmap-meta">
        <span className="ev-heatmap-readout ev-mono ev-num">
          {hovered
            ? `${hovered.date} · ${t("usage.tooltipTurns", {
                turns: hovered.turns,
                tokens: formatTokens(hovered.totalTokens),
                cost: formatCost(hovered.cost),
              })}`
            : "\u00A0"}
        </span>
        <div className="ev-heatmap-scale">
          <span>{t("usage.heatmapLess")}</span>
          {([0, 1, 2, 3, 4] as const).map((lvl) => (
            <span key={lvl} className="ev-heatmap-swatch" data-level={lvl} />
          ))}
          <span>{t("usage.heatmapMore")}</span>
        </div>
      </div>

      <div className="ev-heatmap-scroll">
        <svg
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          role="img"
          aria-label={t("usage.heatmapTitle")}
          className="ev-heatmap-svg"
          onMouseLeave={() => setHovered(undefined)}
        >
          {cells.map((cell) => (
            <a
              key={cell.date}
              href={`#heatmap-${cell.date}`}
              aria-label={`${cell.date}: ${formatTokens(cell.totalTokens)}`}
              onClick={(event) => event.preventDefault()}
              onMouseEnter={() => setHovered(cell)}
              onFocus={() => setHovered(cell)}
              onBlur={() => setHovered(undefined)}
            >
              <rect
                x={cell.weekIndex * step}
                y={cell.dayOfWeek * step}
                width={cellSize}
                height={cellSize}
                rx={2.5}
                className="ev-heatmap-cell"
                data-level={cell.level}
              />
            </a>
          ))}
        </svg>
      </div>
    </div>
  );
}

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
  const [range, setRange] = useState<"daily" | "monthly">("daily");
  const { run: runLoadUsage } = useAbortableAsync();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await runLoadUsage((signal) => api.getProjectUsage(project.id, signal));
      if (!next) return;
      setUsage(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [project.id, runLoadUsage]);

  useEffect(() => {
    setUsage(undefined);
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

  const cacheHitNum =
    totals.input + totals.cacheRead > 0
      ? Math.round((totals.cacheRead / (totals.input + totals.cacheRead)) * 100)
      : 0;
  const cacheHitPct = `${cacheHitNum}%`;
  const initialLoading = loading && usage === undefined;

  const dailyBuckets = usage?.daily ?? [];
  const barSeries = useMemo(
    () =>
      range === "daily" ? buildDailySeries(dailyBuckets, 14) : buildMonthlySeries(dailyBuckets, 6),
    [dailyBuckets, range],
  );
  const heatmapCells = useMemo(() => buildHeatmapGrid(dailyBuckets, 16), [dailyBuckets]);
  const hasDailyData = dailyBuckets.length > 0;

  return (
    <section className="ev-page">
      <ProjectHeader
        project={project}
        view="usage"
        onSelectView={onSelectView}
        onEditProject={onEditProject}
        actions={
          <EvTooltip content={t("usage.refresh")} side="bottom">
            <IconButton
              aria-label={t("usage.refresh")}
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshIcon width={16} height={16} />
            </IconButton>
          </EvTooltip>
        }
      />

      <div className="ev-page-scroll">
        <div className="ev-page-narrow">
          {error && <div className="ev-error-banner">{error}</div>}

          <div className="ev-stat-grid">
            <div className="ev-stat-cell">
              <span className="ev-stat-k">{t("usage.cost")}</span>
              <span className="ev-stat-v">
                {initialLoading ? <Skeleton>$0.00</Skeleton> : formatCost(totals.cost)}
              </span>
            </div>
            <div className="ev-stat-cell">
              <span className="ev-stat-k">{t("usage.input")}</span>
              <span className="ev-stat-v">
                {initialLoading ? <Skeleton>0.0k</Skeleton> : formatTokens(totals.input)}
              </span>
            </div>
            <div className="ev-stat-cell">
              <span className="ev-stat-k">{t("usage.output")}</span>
              <span className="ev-stat-v">
                {initialLoading ? <Skeleton>0.0k</Skeleton> : formatTokens(totals.output)}
              </span>
            </div>
            <div className="ev-stat-cell">
              <span className="ev-stat-k">{t("usage.cacheHit")}</span>
              <span className="ev-stat-v">
                {initialLoading ? <Skeleton>0%</Skeleton> : cacheHitPct}
              </span>
              {!initialLoading && (
                <Meter.Root
                  className="ev-stat-meter"
                  value={cacheHitNum}
                  min={0}
                  max={100}
                  aria-label={t("usage.cacheHit")}
                >
                  <Meter.Track>
                    <Meter.Indicator />
                  </Meter.Track>
                </Meter.Root>
              )}
            </div>
          </div>

          {!initialLoading && hasDailyData && (
            <div className="ev-usage-viz-grid">
              <Section.Root className="ev-usage-card">
                <div className="ev-usage-card-head">
                  <Heading level={2} size={6} className="ev-section-subtitle">
                    {t("usage.trendTitle")}
                  </Heading>
                  <SegmentedControl.Root
                    density="compact"
                    value={[range]}
                    onValueChange={(vals) => {
                      const v = vals[0];
                      if (v === "daily" || v === "monthly") setRange(v);
                    }}
                  >
                    <SegmentedControl.Item value="daily">
                      {t("usage.range.daily")}
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="monthly">
                      {t("usage.range.monthly")}
                    </SegmentedControl.Item>
                  </SegmentedControl.Root>
                </div>
                <Section.Content>
                  <UsageStackedBarChart points={barSeries} ariaLabel={t("usage.trendTitle")} />
                </Section.Content>
              </Section.Root>

              <Section.Root className="ev-usage-card">
                <div className="ev-usage-card-head">
                  <Heading level={2} size={6} className="ev-section-subtitle">
                    {t("usage.heatmapTitle")}
                  </Heading>
                </div>
                <Section.Content>
                  <UsageActivityHeatmap cells={heatmapCells} />
                </Section.Content>
              </Section.Root>
            </div>
          )}

          <Section.Root className="ev-usage-section">
            <Heading level={2} size={6} className="ev-section-subtitle">
              {t("usage.byModel")}
            </Heading>

            <Section.Content>
              {initialLoading ? (
                <div className="ev-table-frame ev-skeleton-table" role="status" aria-busy="true">
                  <SkeletonText lines={4} />
                </div>
              ) : rows.length === 0 ? (
                <div className="ev-empty-box">{t("usage.empty")}</div>
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
                      {rows.map(({ model, stats }) => {
                        const provider = model.includes("/") ? model.split("/", 1)[0] : undefined;
                        return (
                          <Table.Row key={model}>
                            <Table.Cell>
                              <span className="ev-usage-model-cell">
                                <ProviderIcon provider={provider} size={14} />
                                <span className="ev-mono">{model}</span>
                              </span>
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
                        );
                      })}
                    </Table.Body>
                  </Table.Root>
                </Table.Container>
              )}
            </Section.Content>
          </Section.Root>
        </div>
      </div>
    </section>
  );
}
