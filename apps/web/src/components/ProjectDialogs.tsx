import { Button, Field, Input, Modal, SegmentedControl, Text } from "@earendil-works/elanor-react";
import type { ProjectSummary, ToolsSettings } from "@eevee/protocol";
import { useEffect, useId, useState } from "react";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { showToast } from "../lib/toasts.ts";
import { useAbortableAsync } from "../lib/useAbortableAsync.ts";
import { McpTab } from "./settings/McpTab.tsx";
import { SkillsTab } from "./settings/SkillsTab.tsx";
import {
  hasToolsOverrides,
  resolveToolsSettings,
  ToolsSettingsEditor,
} from "./settings/ToolsSettingsEditor.tsx";
import { mergeWorkspacePaths, WorkspacesField } from "./WorkspacesField.tsx";

type EditProjectTab = "general" | "tools" | "skills" | "mcp";

type ProjectDraft = {
  readonly title: string;
  readonly workspaces: readonly string[];
  readonly pendingPath: string;
  readonly tools: ToolsSettings | undefined;
  readonly inlineBudget: string;
  readonly dirty: boolean;
};

const EMPTY_DRAFT: ProjectDraft = {
  title: "",
  workspaces: [],
  pendingPath: "",
  tools: undefined,
  inlineBudget: "",
  dirty: false,
};

export function EditProjectModal({
  project,
  onClose,
  onUpdated,
}: {
  readonly project: ProjectSummary | undefined;
  readonly onClose: () => void;
  readonly onUpdated: (updated: ProjectSummary) => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [activeTab, setActiveTab] = useState<EditProjectTab>("general");
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_DRAFT);
  const [inheritedTools, setInheritedTools] = useState<ToolsSettings | undefined>(undefined);
  const [globalStatus, setGlobalStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const { run: runLoadSettings, abort: abortLoadSettings } = useAbortableAsync();

  useEffect(() => {
    if (!project) {
      abortLoadSettings();
      return;
    }
    setActiveTab("general");
    setDraft({
      title: project.title,
      workspaces: [...project.workspaces],
      pendingPath: "",
      tools: project.tools,
      inlineBudget: String(project.tools?.codemode?.inlineBudget ?? ""),
      dirty: false,
    });
    setInheritedTools(undefined);
    setGlobalStatus("loading");
    setError(undefined);
    void runLoadSettings((signal) => api.getSettings(signal))
      .then((settings) => {
        if (!settings) return;
        setInheritedTools(settings.tools);
        setGlobalStatus("ready");
      })
      .catch((err: unknown) => {
        setGlobalStatus("error");
        setError(
          t("project.edit.globalLoadError", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      });
  }, [project, runLoadSettings, abortLoadSettings, t]);

  const patchDraft = (patch: Partial<Omit<ProjectDraft, "dirty">>) => {
    setDraft((prev) => ({ ...prev, ...patch, dirty: true }));
  };

  const saveDraft = async () => {
    if (!project) return;
    const workspaces = mergeWorkspacePaths(draft.workspaces, draft.pendingPath).next;
    if (workspaces.length === 0) {
      setActiveTab("general");
      setError(t("project.workspace.atLeastOne"));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const nextTools = resolveToolsSettings(draft.tools, draft.inlineBudget, "project");
      const res = await api.updateProject(project.id, {
        title: draft.title.trim() || project.title,
        workspaces,
        tools: nextTools ?? null,
      });
      setDraft((prev) => ({ ...prev, workspaces, pendingPath: "", dirty: false }));
      onUpdated(res.project);
      showToast(t("project.edit.updated"));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const hasToolOverrides = hasToolsOverrides(draft.tools) || draft.inlineBudget.trim().length > 0;
  const isFieldsTab = activeTab === "general" || activeTab === "tools";

  return (
    <Modal.Root open={project !== undefined} onOpenChange={(o) => !o && onClose()}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup className="ev-project-edit-dialog">
            <div className="ev-project-edit-head">
              <Modal.Title>{t("project.edit.title", { title: project?.title ?? "" })}</Modal.Title>
              <SegmentedControl.Root
                density="compact"
                value={[activeTab]}
                onValueChange={(vals) => {
                  const next = vals[0];
                  if (
                    next === "general" ||
                    next === "tools" ||
                    next === "skills" ||
                    next === "mcp"
                  ) {
                    setActiveTab(next);
                  }
                }}
              >
                <SegmentedControl.Item value="general">
                  {t("project.edit.tab.general")}
                </SegmentedControl.Item>
                <SegmentedControl.Item value="tools">
                  <span className="ev-tab-with-dot">
                    {t("project.edit.tab.tools")}
                    {hasToolOverrides && (
                      <span className="ev-tool-override-dot" aria-hidden="true" />
                    )}
                  </span>
                </SegmentedControl.Item>
                <SegmentedControl.Item value="skills">
                  {t("project.edit.tab.skills")}
                </SegmentedControl.Item>
                <SegmentedControl.Item value="mcp">
                  {t("project.edit.tab.mcp")}
                </SegmentedControl.Item>
              </SegmentedControl.Root>
            </div>

            <Modal.Body className="ev-project-edit-body">
              {error && <div className="ev-error-banner">{error}</div>}

              {isFieldsTab && (
                <form
                  id={formId}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveDraft();
                  }}
                  className="ev-form-stack"
                >
                  {activeTab === "general" ? (
                    <>
                      <Field.Root>
                        <Field.Label>{t("project.field.name")}</Field.Label>
                        <Input
                          type="text"
                          value={draft.title}
                          onValueChange={(title) => patchDraft({ title })}
                        />
                      </Field.Root>
                      <WorkspacesField
                        value={draft.workspaces}
                        onChange={(workspaces) => {
                          patchDraft({ workspaces });
                          if (error) setError(undefined);
                        }}
                        pendingPath={draft.pendingPath}
                        onPendingPathChange={(pendingPath) => patchDraft({ pendingPath })}
                        disabled={saving}
                      />
                    </>
                  ) : (
                    <div className="ev-form-stack">
                      {globalStatus !== "ready" && (
                        <div className="ev-inline-hint">
                          {globalStatus === "loading"
                            ? t("project.edit.loadingGlobal")
                            : t("project.edit.globalUnavailable")}
                        </div>
                      )}
                      <ToolsSettingsEditor
                        variant="project"
                        value={draft.tools}
                        onChange={(tools) => patchDraft({ tools })}
                        inheritedTools={inheritedTools}
                        inlineBudget={draft.inlineBudget}
                        onInlineBudgetChange={(inlineBudget) => patchDraft({ inlineBudget })}
                        disabled={globalStatus !== "ready"}
                      />
                    </div>
                  )}
                </form>
              )}

              {project && activeTab === "skills" && <SkillsTab projectId={project.id} compact />}
              {project && activeTab === "mcp" && <McpTab projectId={project.id} compact />}
            </Modal.Body>

            <Modal.Actions className="ev-project-edit-actions">
              {isFieldsTab ? (
                <>
                  <Modal.Close
                    render={
                      <Button type="button" hierarchy="secondary">
                        {t("common.cancel")}
                      </Button>
                    }
                  />
                  <Button type="submit" form={formId} hierarchy="primary" pending={saving}>
                    {t("common.save")}
                  </Button>
                </>
              ) : (
                <>
                  {draft.dirty && (
                    <Button
                      type="button"
                      hierarchy="secondary"
                      pending={saving}
                      onClick={() => void saveDraft()}
                    >
                      {t("project.edit.saveGeneralTools")}
                    </Button>
                  )}
                  <Modal.Close
                    render={
                      <Button type="button" hierarchy="primary">
                        {t("common.done")}
                      </Button>
                    }
                  />
                </>
              )}
            </Modal.Actions>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}

export function DeleteProjectModal({
  project,
  onClose,
  onDeleted,
}: {
  readonly project: ProjectSummary | undefined;
  readonly onClose: () => void;
  readonly onDeleted: (id: string) => void;
}) {
  const { t } = useI18n();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const confirm = async () => {
    if (!project) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteProject(project.id);
      showToast(t("project.delete.deleted", { title: project.title }));
      onDeleted(project.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  return (
    <Modal.Root open={project !== undefined} onOpenChange={(o) => !o && onClose()}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup>
            <Modal.Title>{t("project.delete.title", { title: project?.title ?? "" })}</Modal.Title>
            <Modal.Body>
              <div className="ev-form-stack">
                {error && <div className="ev-error-banner">{error}</div>}
                <Text style={{ margin: 0 }}>
                  {t("project.delete.bodyPrefix")}
                  <strong>{t("project.delete.bodyStrong")}</strong>
                  {t("project.delete.bodySuffix")}
                </Text>
              </div>
            </Modal.Body>
            <Modal.Actions>
              <Modal.Close render={<Button hierarchy="secondary">{t("common.cancel")}</Button>} />
              <Button
                hierarchy="primary"
                semantic="negative"
                pending={deleting}
                onClick={() => void confirm()}
              >
                {t("project.delete.confirm")}
              </Button>
            </Modal.Actions>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
