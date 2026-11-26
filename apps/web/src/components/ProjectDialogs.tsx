import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import { Button, Field, Input, Modal, Text, TextArea } from "@earendil-works/elanor-react";
import type { ProjectSummary, ToolsSettings } from "@eevee/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { showToast } from "../lib/toasts.ts";
import {
  hasToolsOverrides,
  resolveToolsSettings,
  ToolsSettingsEditor,
} from "./settings/ToolsSettingsEditor.tsx";

export function EditProjectModal({
  project,
  onClose,
  onUpdated,
}: {
  readonly project: ProjectSummary | undefined;
  readonly onClose: () => void;
  readonly onUpdated: (updated: ProjectSummary) => void;
}) {
  const [title, setTitle] = useState("");
  const [workspacesText, setWorkspacesText] = useState("");
  const [tools, setTools] = useState<ToolsSettings | undefined>(undefined);
  const [inheritedTools, setInheritedTools] = useState<ToolsSettings | undefined>(undefined);
  const [inlineBudget, setInlineBudget] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [globalStatus, setGlobalStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!project) return;
    let active = true;
    setTitle(project.title);
    setWorkspacesText(project.workspaces.join("\n"));
    setTools(project.tools);
    setInlineBudget(String(project.tools?.codemode?.inlineBudget ?? ""));
    setToolsOpen(hasToolsOverrides(project.tools));
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

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!project) return;
    const workspaces = workspacesText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (workspaces.length === 0) {
      setError("至少保留一个工作目录。");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const nextTools = resolveToolsSettings(tools, inlineBudget, "project");
      const res = await api.updateProject(project.id, {
        title: title.trim() || project.title,
        workspaces,
        tools: nextTools ?? null,
      });
      onUpdated(res.project);
      showToast("项目配置已更新");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal.Root open={project !== undefined} onOpenChange={(o) => !o && onClose()}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup>
            <Modal.Title>编辑项目</Modal.Title>
            <form onSubmit={(e) => void handleSubmit(e)} className="ev-form-stack">
              <Modal.Body>
                <div className="ev-form-stack">
                  {error && <div className="ev-error-banner">{error}</div>}
                  <Field.Root>
                    <Field.Label>名称</Field.Label>
                    <Input type="text" value={title} onValueChange={setTitle} />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>工作目录</Field.Label>
                    <TextArea
                      monospace
                      rows={4}
                      value={workspacesText}
                      onValueChange={setWorkspacesText}
                    />
                  </Field.Root>
                  <details
                    key={project?.id}
                    className="ev-tool-disclosure"
                    open={toolsOpen}
                    onToggle={(event) => setToolsOpen(event.currentTarget.open)}
                  >
                    <summary>
                      <ChevronRightIcon
                        className="ev-tool-disclosure-chevron"
                        width={14}
                        height={14}
                      />
                      <span>工具覆盖（可选）</span>
                      {(hasToolsOverrides(tools) || inlineBudget.trim()) && (
                        <span className="eevee-badge" data-tone="info">
                          项目覆盖
                        </span>
                      )}
                    </summary>
                    <div className="ev-tool-disclosure-body">
                      {globalStatus !== "ready" && (
                        <div className="ev-tool-group-hint">
                          {globalStatus === "loading"
                            ? "正在读取全局设置…"
                            : "全局设置不可用，工具覆盖暂不可编辑。"}
                        </div>
                      )}
                      <ToolsSettingsEditor
                        variant="project"
                        value={tools}
                        onChange={setTools}
                        inheritedTools={inheritedTools}
                        inlineBudget={inlineBudget}
                        onInlineBudgetChange={setInlineBudget}
                        disabled={globalStatus !== "ready"}
                      />
                    </div>
                  </details>
                </div>
              </Modal.Body>
              <Modal.Actions style={{ marginTop: 12 }}>
                <Modal.Close
                  render={
                    <Button type="button" hierarchy="secondary">
                      取消
                    </Button>
                  }
                />
                <Button type="submit" hierarchy="primary" pending={saving}>
                  保存
                </Button>
              </Modal.Actions>
            </form>
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
