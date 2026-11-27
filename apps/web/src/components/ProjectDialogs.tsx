import {
  Button,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Text,
  TextArea,
} from "@earendil-works/elanor-react";
import type { ProjectSummary, ToolsSettings } from "@eevee/protocol";
import { useEffect, useId, useState } from "react";
import { api } from "../lib/api.ts";
import { showToast } from "../lib/toasts.ts";
import { McpTab } from "./settings/McpTab.tsx";
import { SkillsTab } from "./settings/SkillsTab.tsx";
import {
  hasToolsOverrides,
  resolveToolsSettings,
  ToolsSettingsEditor,
} from "./settings/ToolsSettingsEditor.tsx";

type EditProjectTab = "general" | "tools" | "skills" | "mcp";

type ProjectDraft = {
  readonly title: string;
  readonly workspaces: string;
  readonly tools: ToolsSettings | undefined;
  readonly inlineBudget: string;
  readonly dirty: boolean;
};

const EMPTY_DRAFT: ProjectDraft = {
  title: "",
  workspaces: "",
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
  const formId = useId();
  const [activeTab, setActiveTab] = useState<EditProjectTab>("general");
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_DRAFT);
  const [inheritedTools, setInheritedTools] = useState<ToolsSettings | undefined>(undefined);
  const [globalStatus, setGlobalStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!project) return;
    let active = true;
    setActiveTab("general");
    setDraft({
      title: project.title,
      workspaces: project.workspaces.join("\n"),
      tools: project.tools,
      inlineBudget: String(project.tools?.codemode?.inlineBudget ?? ""),
      dirty: false,
    });
    setInheritedTools(undefined);
    setGlobalStatus("loading");
    setError(undefined);
    void api
      .getSettings()
      .then((settings) => {
        if (!active) return;
        setInheritedTools(settings.tools);
        setGlobalStatus("ready");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setGlobalStatus("error");
        setError(`全局设置加载失败：${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      active = false;
    };
  }, [project]);

  const patchDraft = (patch: Partial<Omit<ProjectDraft, "dirty">>) => {
    setDraft((prev) => ({ ...prev, ...patch, dirty: true }));
  };

  const saveDraft = async () => {
    if (!project) return;
    const workspaces = draft.workspaces
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (workspaces.length === 0) {
      setActiveTab("general");
      setError("至少保留一个工作目录。");
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
      setDraft((prev) => ({ ...prev, dirty: false }));
      onUpdated(res.project);
      showToast("项目配置已更新");
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
              <Modal.Title>编辑项目 · {project?.title ?? ""}</Modal.Title>
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
                <SegmentedControl.Item value="general">基本信息</SegmentedControl.Item>
                <SegmentedControl.Item value="tools">
                  工具{hasToolOverrides ? " · 已覆盖" : ""}
                </SegmentedControl.Item>
                <SegmentedControl.Item value="skills">Skills</SegmentedControl.Item>
                <SegmentedControl.Item value="mcp">MCP</SegmentedControl.Item>
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
                        <Field.Label>名称</Field.Label>
                        <Input
                          type="text"
                          value={draft.title}
                          onValueChange={(title) => patchDraft({ title })}
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>工作目录（每行一个绝对路径）</Field.Label>
                        <TextArea
                          monospace
                          rows={5}
                          value={draft.workspaces}
                          onValueChange={(workspaces) => patchDraft({ workspaces })}
                        />
                      </Field.Root>
                    </>
                  ) : (
                    <div className="ev-form-stack">
                      {globalStatus !== "ready" && (
                        <div className="ev-tool-group-hint">
                          {globalStatus === "loading"
                            ? "正在读取全局设置…"
                            : "全局设置不可用，工具覆盖暂不可编辑。"}
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
                        取消
                      </Button>
                    }
                  />
                  <Button type="submit" form={formId} hierarchy="primary" pending={saving}>
                    保存
                  </Button>
                </>
              ) : (
                <>
                  <span className="ev-project-edit-note">
                    {draft.dirty
                      ? "基本/工具标签页有未保存修改"
                      : "Skills 与项目级 MCP 修改即时生效"}
                  </span>
                  {draft.dirty && (
                    <Button
                      type="button"
                      hierarchy="secondary"
                      pending={saving}
                      onClick={() => void saveDraft()}
                    >
                      保存基本/工具修改
                    </Button>
                  )}
                  <Modal.Close
                    render={
                      <Button type="button" hierarchy="primary">
                        完成
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
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const confirm = async () => {
    if (!project) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteProject(project.id);
      showToast(`已删除项目「${project.title}」`);
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
            <Modal.Title>删除项目「{project?.title ?? ""}」？</Modal.Title>
            <Modal.Body>
              <div className="ev-form-stack">
                {error && <div className="ev-error-banner">{error}</div>}
                <Text style={{ margin: 0 }}>
                  此操作会停止该项目未完成的后台任务并清除其 Eevee 会话记录，但
                  <strong>绝不会触碰工作目录中的任何文件</strong>。
                </Text>
              </div>
            </Modal.Body>
            <Modal.Actions>
              <Modal.Close render={<Button hierarchy="secondary">取消</Button>} />
              <Button
                hierarchy="primary"
                semantic="negative"
                pending={deleting}
                onClick={() => void confirm()}
              >
                确认删除
              </Button>
            </Modal.Actions>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
