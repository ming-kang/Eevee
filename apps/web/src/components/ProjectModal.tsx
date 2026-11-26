import { Button, Field, Input, Modal, TextArea } from "@earendil-works/elanor-react";
import type { ProjectSummary } from "@eevee/protocol";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.ts";

export type ProjectModalProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (project: ProjectSummary) => void;
};

export function ProjectModal({ open, onOpenChange, onCreated }: ProjectModalProps) {
  const [title, setTitle] = useState("");
  const [workspacesText, setWorkspacesText] = useState("");
  const [memory, setMemory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const workspaces = workspacesText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (workspaces.length === 0) {
      setError("至少填写一个工作区绝对路径（每行一个目录）。");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const created = await api.createProject({
        workspaces,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(memory.trim() ? { memory: memory.trim() } : {}),
      });
      setTitle("");
      setWorkspacesText("");
      setMemory("");
      onCreated(created.project);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup>
            <Modal.Title>新建项目</Modal.Title>
            <form onSubmit={(event) => void handleSubmit(event)} className="ev-form-stack">
              <Modal.Body>
                <div className="ev-form-stack">
                  {error && <div className="ev-error-banner">{error}</div>}
                  <Field.Root>
                    <Field.Label>名称</Field.Label>
                    <Input
                      type="text"
                      value={title}
                      onValueChange={(value) => setTitle(value)}
                      placeholder="可选"
                    />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>工作目录</Field.Label>
                    <TextArea
                      monospace
                      rows={3}
                      value={workspacesText}
                      onValueChange={(value) => setWorkspacesText(value)}
                      placeholder={"/path/to/repo"}
                    />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>项目记忆</Field.Label>
                    <TextArea
                      rows={3}
                      value={memory}
                      onValueChange={(value) => setMemory(value)}
                      placeholder="可选"
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
                <Button type="submit" hierarchy="primary" pending={submitting}>
                  创建
                </Button>
              </Modal.Actions>
            </form>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
