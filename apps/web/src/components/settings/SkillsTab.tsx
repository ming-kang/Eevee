import { RefreshIcon, UndoIcon, WarningIcon } from "@earendil-works/elanor-icons-react";
import { Button, Heading, SegmentedControl } from "@earendil-works/elanor-react";
import type {
  SkillDiagnostic,
  SkillEntry,
  SkillPolicyMap,
  SkillsListResponse,
  SkillTriggerMode,
} from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { shortPath } from "../../lib/format.ts";
import { type LocaleKey, useI18n } from "../../lib/i18n.ts";
import { showToast } from "../../lib/toasts.ts";
import { useAbortableAsync } from "../../lib/useAbortableAsync.ts";
import { SearchField } from "../SearchField.tsx";

type ProjectSkillChoice = SkillTriggerMode | "inherit";

function modeLabelKey(mode: SkillTriggerMode): LocaleKey {
  if (mode === "model") return "skills.mode.model";
  if (mode === "user") return "skills.mode.user";
  return "skills.mode.disabled";
}

function diagnosticTone(type: SkillDiagnostic["type"]): "negative" | "warning" {
  return type === "error" ? "negative" : "warning";
}

function diagnosticLabelKey(type: SkillDiagnostic["type"]): LocaleKey {
  if (type === "collision") return "skills.diag.collision";
  if (type === "error") return "skills.diag.error";
  return "skills.diag.warning";
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
  const { t } = useI18n();
  const client = useMemo(() => api.skills(projectId), [projectId]);
  const [data, setData] = useState<SkillsListResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [pendingSkill, setPendingSkill] = useState<string | undefined>(undefined);
  const [resetting, setResetting] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const { run: runLoad } = useAbortableAsync();
  const activeClientRef = useRef(client);
  activeClientRef.current = client;

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await runLoad((signal) => client.list(signal));
      if (!res || activeClientRef.current !== client) return;
      setData(res);
      setLoading(false);
    } catch (err) {
      if (activeClientRef.current === client) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
  }, [client, runLoad]);

  useEffect(() => {
    void load();
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

  const handlePolicyChange = async (skill: SkillEntry, choice: ProjectSkillChoice) => {
    if (!data || pendingSkill) return;
    setPendingSkill(skill.name);
    setError(undefined);
    try {
      const policy = projectId
        ? buildProjectPolicy(data.projectPolicy, skill.name, choice)
        : choice === "inherit"
          ? data.globalPolicy
          : buildGlobalPolicy(data.globalPolicy, skill, choice);
      const updated = await client.putPolicy({ policy });
      if (activeClientRef.current === client) {
        setData(updated);
      }
    } catch (err) {
      if (activeClientRef.current === client) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (activeClientRef.current === client) {
        setPendingSkill(undefined);
      }
    }
  };

  const handleResetProjectOverrides = async () => {
    if (!projectId || resetting) return;
    setResetting(true);
    setError(undefined);
    try {
      const updated = await client.putPolicy({ policy: null });
      if (activeClientRef.current === client) {
        setData(updated);
        showToast(t("skills.resetToast"));
      }
    } catch (err) {
      if (activeClientRef.current === client) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (activeClientRef.current === client) {
        setResetting(false);
      }
    }
  };

  return (
    <div className="ev-settings-section">
      <div className="ev-settings-head">
        <div className="ev-skill-head-title">
          <Heading level={compact ? 3 : 2} size={compact ? 6 : 5}>
            Skills
            <span className="ev-num ev-heading-count">{summary.total}</span>
          </Heading>
          {projectId && projectOverrideCount > 0 && (
            <span className="eevee-badge ev-num" data-tone="warning">
              {t("skills.projectOverrideCount", { count: projectOverrideCount })}
            </span>
          )}
        </div>
        <div className="ev-catalog-toolbar">
          <SearchField
            size="compact"
            className="ev-catalog-search"
            value={query}
            onChange={setQuery}
            placeholder={t("skills.searchPlaceholder")}
            ariaLabel={t("skills.searchLabel")}
            clearOnEscape
          />
          {projectId && projectOverrideCount > 0 && (
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              iconStart={<UndoIcon width={14} height={14} />}
              disabled={pendingSkill !== undefined}
              pending={resetting}
              onClick={() => void handleResetProjectOverrides()}
            >
              {t("skills.resetOverrides")}
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
            {t("common.refresh")}
          </Button>
        </div>
      </div>

      {error && <div className="ev-error-banner">{error}</div>}

      {diagnostics.length > 0 && (
        <div className="ev-warning-banner" role="alert">
          <div className="ev-warning-banner-head">
            <WarningIcon width={16} height={16} />
            <strong>{t("skills.diagnosticsTitle", { count: diagnostics.length })}</strong>
          </div>
          <div className="ev-diagnostic-list">
            {diagnostics.map((diag) => (
              <div
                key={`${diag.type}:${diag.path}:${diag.skillName ?? ""}:${diag.message}`}
                className="ev-diagnostic-item"
              >
                <span className="eevee-badge" data-tone={diagnosticTone(diag.type)}>
                  {t(diagnosticLabelKey(diag.type))}
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
        <div className="ev-empty-box">{t("skills.loading")}</div>
      ) : filteredSkills.length === 0 ? (
        <div className="ev-empty-box">
          {skills.length === 0
            ? projectId
              ? t("skills.emptyProject")
              : t("skills.emptyGlobal")
            : t("skills.emptyMatch")}
        </div>
      ) : (
        <div className="ev-settings-list">
          {filteredSkills.map((skill) => {
            const busy = pendingSkill === skill.name || resetting;
            const inheritedMode = skill.globalOverride ?? skill.defaultMode;
            const inheritedModeLabel = t(modeLabelKey(inheritedMode));
            const projectChoice: ProjectSkillChoice = skill.projectOverride ?? "inherit";
            const sourceLabel = t(
              skill.source === "workspace" ? "skills.source.workspace" : "skills.source.global",
            );

            return (
              <div key={`${skill.name}:${skill.path}`} className="ev-settings-row">
                <div className="ev-skill-row-main">
                  <div className="ev-skill-info">
                    <div className="ev-skill-title-row">
                      <strong className="ev-mono">{skill.name}</strong>
                      {projectId && (
                        <span
                          className="eevee-badge"
                          data-tone={skill.source === "workspace" ? "info" : undefined}
                          title={skill.path}
                        >
                          {sourceLabel}
                        </span>
                      )}
                      {skill.disableModelInvocation && (
                        <span className="eevee-badge" title={t("skills.frontmatterUserOnlyTitle")}>
                          {t("skills.frontmatterUserOnly")}
                        </span>
                      )}
                      {((!projectId && skill.globalOverride !== undefined) ||
                        (projectId && skill.projectOverride !== undefined)) && (
                        <span className="eevee-badge" data-tone={projectId ? "warning" : "info"}>
                          {t("skills.overridden")}
                        </span>
                      )}
                    </div>
                    {skill.description && <div className="ev-skill-desc">{skill.description}</div>}
                    <div className="ev-skill-path ev-mono ev-truncate" title={skill.path}>
                      {shortPath(skill.path)}
                    </div>
                  </div>

                  <div className="ev-skill-control">
                    <SegmentedControl.Root
                      density="compact"
                      disabled={busy}
                      value={[projectId ? projectChoice : skill.effectiveMode]}
                      onValueChange={(vals) => {
                        const next = vals[0];
                        if (
                          next === "inherit" ||
                          next === "model" ||
                          next === "user" ||
                          next === "disabled"
                        ) {
                          void handlePolicyChange(skill, next);
                        }
                      }}
                    >
                      {projectId && (
                        <SegmentedControl.Item
                          value="inherit"
                          title={t("skills.inheritTitle", { mode: inheritedModeLabel })}
                        >
                          {t("skills.mode.inherit")}
                        </SegmentedControl.Item>
                      )}
                      <SegmentedControl.Item value="model">
                        {t("skills.mode.model")}
                      </SegmentedControl.Item>
                      <SegmentedControl.Item value="user">
                        {t("skills.mode.user")}
                      </SegmentedControl.Item>
                      <SegmentedControl.Item value="disabled">
                        {t("skills.mode.disabled")}
                      </SegmentedControl.Item>
                    </SegmentedControl.Root>
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
