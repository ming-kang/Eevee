import {
  CloseIcon,
  RefreshIcon,
  SearchIcon,
  UndoIcon,
  WarningIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, Heading, SegmentedControl, Text } from "@earendil-works/elanor-react";
import type {
  SkillDiagnostic,
  SkillEntry,
  SkillPolicyMap,
  SkillsListResponse,
  SkillTriggerMode,
} from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { showToast } from "../../lib/toasts.ts";

type ProjectSkillChoice = SkillTriggerMode | "inherit";

function modeLabel(mode: SkillTriggerMode): string {
  if (mode === "model") return "模型可触发";
  if (mode === "user") return "仅用户触发";
  return "禁用";
}

function diagnosticTone(type: SkillDiagnostic["type"]): "negative" | "warning" {
  return type === "error" ? "negative" : "warning";
}

function diagnosticLabel(type: SkillDiagnostic["type"]): string {
  if (type === "collision") return "名称冲突";
  if (type === "error") return "错误";
  return "警告";
}

function buildGlobalPolicy(
  current: SkillPolicyMap,
  skill: SkillEntry,
  nextMode: SkillTriggerMode,
): SkillPolicyMap | null {
  const next: Record<string, SkillTriggerMode> = { ...current };
  if (nextMode === skill.defaultMode) {
    delete next[skill.name];
  } else {
    next[skill.name] = nextMode;
  }
  return Object.keys(next).length > 0 ? next : null;
}

function buildProjectPolicy(
  current: SkillPolicyMap | undefined,
  skillName: string,
  choice: ProjectSkillChoice,
): SkillPolicyMap | null {
  const next: Record<string, SkillTriggerMode> = { ...(current ?? {}) };
  if (choice === "inherit") {
    delete next[skillName];
  } else {
    next[skillName] = choice;
  }
  return Object.keys(next).length > 0 ? next : null;
}

export function SkillsTab({
  projectId,
  compact = false,
}: {
  readonly projectId?: string;
  readonly compact?: boolean;
}) {
  const [data, setData] = useState<SkillsListResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [pendingSkill, setPendingSkill] = useState<string | undefined>(undefined);
  const [resetting, setResetting] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const res = projectId
        ? await api.listProjectSkills(projectId, controller.signal)
        : await api.listSkills(controller.signal);
      if (!controller.signal.aborted) {
        setData(res);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  const skills = data?.skills ?? [];
  const diagnostics = data?.diagnostics ?? [];
  const projectOverrideCount = Object.keys(data?.projectPolicy ?? {}).length;

  const summary = useMemo(() => {
    let model = 0;
    let user = 0;
    let disabled = 0;
    for (const skill of skills) {
      if (skill.effectiveMode === "model") model += 1;
      else if (skill.effectiveMode === "user") user += 1;
      else disabled += 1;
    }
    return { total: skills.length, model, user, disabled };
  }, [skills]);

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((skill) =>
      `${skill.name} ${skill.description} ${skill.path} ${skill.workspace ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [skills, query]);

  const handleGlobalChange = async (skill: SkillEntry, nextMode: SkillTriggerMode) => {
    if (!data || pendingSkill) return;
    setPendingSkill(skill.name);
    setError(undefined);
    try {
      const policy = buildGlobalPolicy(data.globalPolicy, skill, nextMode);
      const updated = await api.putSkillsPolicy({ policy });
      setData(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingSkill(undefined);
    }
  };

  const handleProjectChange = async (skill: SkillEntry, choice: ProjectSkillChoice) => {
    if (!data || !projectId || pendingSkill) return;
    setPendingSkill(skill.name);
    setError(undefined);
    try {
      const policy = buildProjectPolicy(data.projectPolicy, skill.name, choice);
      const updated = await api.putProjectSkillsPolicy(projectId, { policy });
      setData(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingSkill(undefined);
    }
  };

  const handleResetProjectOverrides = async () => {
    if (!projectId || resetting) return;
    setResetting(true);
    setError(undefined);
    try {
      const updated = await api.putProjectSkillsPolicy(projectId, { policy: null });
      setData(updated);
      showToast("已重置项目 Skills 触发策略覆写");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="ev-settings-section">
      <div className="ev-settings-head">
        <div className="ev-skill-head-title">
          <Heading level={compact ? 3 : 2} size={compact ? 6 : 5}>
            Skills
          </Heading>
          <span className="eevee-badge ev-num">共 {summary.total} 个</span>
          {summary.total > 0 && (
            <span className="ev-inline-muted ev-num">
              模型可触发 {summary.model} · 仅用户 {summary.user} · 禁用 {summary.disabled}
            </span>
          )}
          {projectId && projectOverrideCount > 0 && (
            <span className="eevee-badge ev-num" data-tone="warning">
              项目覆写 {projectOverrideCount}
            </span>
          )}
        </div>
        <div className="ev-inline-actions">
          {projectId && (
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              iconStart={<UndoIcon width={14} height={14} />}
              disabled={projectOverrideCount === 0 || pendingSkill !== undefined}
              pending={resetting}
              onClick={() => void handleResetProjectOverrides()}
            >
              重置项目覆写
            </Button>
          )}
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<RefreshIcon width={15} height={15} />}
            pending={loading}
            onClick={() => void load()}
          >
            刷新
          </Button>
        </div>
      </div>

      <div className="ev-skill-toolbar">
        <div className="ev-probe-search">
          <SearchIcon width={14} height={14} />
          <input
            className="ev-raw-input"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Skill 名称、描述或路径…"
            aria-label="筛选 Skills"
          />
          {query !== "" && (
            <button
              type="button"
              className="ev-task-clear-btn"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
            >
              <CloseIcon width={12} height={12} />
            </button>
          )}
        </div>
      </div>

      {error && <div className="ev-error-banner">{error}</div>}

      {diagnostics.length > 0 && (
        <div className="ev-warning-banner" role="alert">
          <div className="ev-warning-banner-head">
            <WarningIcon width={16} height={16} />
            <strong>Skills 发现诊断（{diagnostics.length}）</strong>
          </div>
          <div className="ev-diagnostic-list">
            {diagnostics.map((diag) => (
              <div
                key={`${diag.type}:${diag.path}:${diag.skillName ?? ""}:${diag.message}`}
                className="ev-diagnostic-item"
              >
                <span className="eevee-badge" data-tone={diagnosticTone(diag.type)}>
                  {diagnosticLabel(diag.type)}
                </span>
                {diag.skillName && <span className="ev-mono">{diag.skillName}</span>}
                <span className="ev-mono ev-inline-muted" title={diag.path}>
                  {diag.path}
                </span>
                <span>{diag.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && data === undefined ? (
        <div className="ev-settings-card" style={{ alignItems: "center", padding: "24px 16px" }}>
          <Text style={{ color: "var(--ev-fg-subtle)", margin: 0 }}>正在扫描 Skills…</Text>
        </div>
      ) : filteredSkills.length === 0 ? (
        <div className="ev-settings-card" style={{ alignItems: "center", padding: "24px 16px" }}>
          <Text style={{ color: "var(--ev-fg-subtle)", margin: 0 }}>
            {skills.length === 0
              ? projectId
                ? "未在全局 (~/.agents/skills) 或项目 (.agents/skills) 中发现 Skills"
                : "未在 ~/.agents/skills 中发现全局 Skills"
              : "没有匹配的 Skill"}
          </Text>
        </div>
      ) : (
        <div className="ev-settings-list">
          {filteredSkills.map((skill) => {
            const busy = pendingSkill === skill.name || resetting;
            const inheritedMode = skill.globalOverride ?? skill.defaultMode;
            const projectChoice: ProjectSkillChoice = skill.projectOverride ?? "inherit";
            const sourceLabel =
              skill.source === "workspace" ? "项目 .agents/skills" : "全局 ~/.agents/skills";

            return (
              <div key={`${skill.name}:${skill.path}`} className="ev-settings-row">
                <div className="ev-skill-row-main">
                  <div className="ev-skill-info">
                    <div className="ev-skill-title-row">
                      <strong className="ev-mono">{skill.name}</strong>
                      <span
                        className="eevee-badge"
                        data-tone={skill.source === "workspace" ? "info" : undefined}
                        title={skill.path}
                      >
                        {sourceLabel}
                      </span>
                      {skill.disableModelInvocation && (
                        <span
                          className="eevee-badge"
                          title="SKILL.md frontmatter 设置 disable-model-invocation"
                        >
                          frontmatter 仅用户
                        </span>
                      )}
                      {!projectId && skill.globalOverride !== undefined && (
                        <span className="eevee-badge" data-tone="info">
                          已覆写
                        </span>
                      )}
                      {projectId && skill.projectOverride !== undefined && (
                        <span className="eevee-badge" data-tone="warning">
                          项目覆写
                        </span>
                      )}
                      {projectId &&
                        skill.projectOverride === undefined &&
                        skill.globalOverride !== undefined && (
                          <span className="eevee-badge">继承全局覆写</span>
                        )}
                    </div>
                    {skill.description && <div className="ev-skill-desc">{skill.description}</div>}
                    <div className="ev-skill-path ev-mono ev-truncate" title={skill.path}>
                      {skill.path}
                    </div>
                  </div>

                  <div className="ev-skill-control">
                    {projectId ? (
                      <>
                        <SegmentedControl.Root
                          density="compact"
                          disabled={busy}
                          value={[projectChoice]}
                          onValueChange={(vals) => {
                            const next = vals[0];
                            if (
                              next === "inherit" ||
                              next === "model" ||
                              next === "user" ||
                              next === "disabled"
                            ) {
                              void handleProjectChange(skill, next);
                            }
                          }}
                        >
                          <SegmentedControl.Item
                            value="inherit"
                            title={`继承上级策略：${modeLabel(inheritedMode)}`}
                          >
                            继承
                          </SegmentedControl.Item>
                          <SegmentedControl.Item value="model">模型可触发</SegmentedControl.Item>
                          <SegmentedControl.Item value="user">仅用户触发</SegmentedControl.Item>
                          <SegmentedControl.Item value="disabled">禁用</SegmentedControl.Item>
                        </SegmentedControl.Root>
                        <span className="ev-inline-muted">
                          {skill.projectOverride === undefined
                            ? `当前继承：${modeLabel(inheritedMode)}`
                            : `上级策略：${modeLabel(inheritedMode)}`}
                        </span>
                      </>
                    ) : (
                      <SegmentedControl.Root
                        density="compact"
                        disabled={busy}
                        value={[skill.effectiveMode]}
                        onValueChange={(vals) => {
                          const next = vals[0];
                          if (next === "model" || next === "user" || next === "disabled") {
                            void handleGlobalChange(skill, next);
                          }
                        }}
                      >
                        <SegmentedControl.Item value="model">模型可触发</SegmentedControl.Item>
                        <SegmentedControl.Item value="user">仅用户触发</SegmentedControl.Item>
                        <SegmentedControl.Item value="disabled">禁用</SegmentedControl.Item>
                      </SegmentedControl.Root>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
