import { Button, Field, Input, Modal, Text, TextArea } from "@earendil-works/elanor-react";
import type { ProjectSummary } from "@eevee/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { showToast } from "../lib/toasts.ts";

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!project) return;
    setTitle(project.title);
    setWorkspacesText(project.workspaces.join("\n"));
    setError(undefined);
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
      const res = await api.updateProject(project.id, {
        title: title.trim() || project.title,
        workspaces,
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
