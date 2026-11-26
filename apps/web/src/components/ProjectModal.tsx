import { Button, Field, Input, Modal, Stack, Text, TextArea } from "@earendil-works/elanor-react";
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
            <Modal.Description>
              每个项目拥有独立持久会话库，可绑定一个或多个本地工作目录。
            </Modal.Description>
            <form onSubmit={(event) => void handleSubmit(event)}>
              <Modal.Body>
                <Stack direction="column" gap="small">
                  {error && <div className="eevee-error-banner">{error}</div>}
                  <Field.Root>
                    <Field.Label>项目名称（可选）</Field.Label>
                    <Input
                      type="text"
                      value={title}
                      onValueChange={(value) => setTitle(value)}
                      placeholder="例如：光学论文 / Eevee"
                    />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>工作目录（每行一个路径）</Field.Label>
                    <TextArea
                      monospace
                      rows={3}
                      value={workspacesText}
                      onValueChange={(value) => setWorkspacesText(value)}
                      placeholder={"/path/to/repo\n/path/to/docs"}
                    />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>初始项目记忆（可选）</Field.Label>
                    <TextArea
                      rows={3}
                      value={memory}
                      onValueChange={(value) => setMemory(value)}
                      placeholder="写下项目背景、约定或偏好，将注入 Router 与 Worker..."
                    />
                  </Field.Root>
                  <Text
                    style={{
                      fontSize: "0.78rem",
                      color: "var(--semantic-color-text-secondary)",
                      margin: 0,
                    }}
                  >
                    删除项目仅清理 Eevee 内部数据，绝不触碰工作目录中的文件。
                  </Text>
                </Stack>
              </Modal.Body>
              <Modal.Actions>
                <Modal.Close
                  render={
                    <Button type="button" hierarchy="secondary">
                      取消
                    </Button>
                  }
                />
                <Button type="submit" hierarchy="primary" pending={submitting}>
                  创建项目
                </Button>
              </Modal.Actions>
            </form>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
