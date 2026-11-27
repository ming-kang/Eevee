import { Button, Field, Input, Modal, TextArea } from "@earendil-works/elanor-react";
import type { ProjectSummary } from "@eevee/protocol";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { mergeWorkspacePaths, WorkspacesField } from "./WorkspacesField.tsx";

export type ProjectModalProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (project: ProjectSummary) => void;
};

export function ProjectModal({ open, onOpenChange, onCreated }: ProjectModalProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [pendingPath, setPendingPath] = useState("");
  const [memory, setMemory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const resolved = mergeWorkspacePaths(workspaces, pendingPath).next;
    if (resolved.length === 0) {
      setError(t("project.workspace.atLeastOne"));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const created = await api.createProject({
        workspaces: resolved,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(memory.trim() ? { memory: memory.trim() } : {}),
      });
      setTitle("");
      setWorkspaces([]);
      setPendingPath("");
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
          <Modal.Popup className="ev-project-create-dialog">
            <Modal.Title>{t("project.new.title")}</Modal.Title>
            <form onSubmit={(event) => void handleSubmit(event)} className="ev-form-stack">
              <Modal.Body>
                <div className="ev-form-stack">
                  {error && <div className="ev-error-banner">{error}</div>}
                  <Field.Root>
                    <Field.Label>{t("project.field.name")}</Field.Label>
                    <Input
                      type="text"
                      value={title}
                      onValueChange={(value) => setTitle(value)}
                      placeholder={t("common.optional")}
                    />
                  </Field.Root>
                  <WorkspacesField
                    value={workspaces}
                    onChange={(next) => {
                      setWorkspaces(next);
                      if (error) setError(undefined);
                    }}
                    pendingPath={pendingPath}
                    onPendingPathChange={setPendingPath}
                    disabled={submitting}
                  />
                  <Field.Root>
                    <Field.Label>{t("project.field.memory")}</Field.Label>
                    <TextArea
                      rows={3}
                      value={memory}
                      onValueChange={(value) => setMemory(value)}
                      placeholder={t("common.optional")}
                    />
                  </Field.Root>
                </div>
              </Modal.Body>
              <Modal.Actions style={{ marginTop: 12 }}>
                <Modal.Close
                  render={
                    <Button type="button" hierarchy="secondary">
                      {t("common.cancel")}
                    </Button>
                  }
                />
                <Button type="submit" hierarchy="primary" pending={submitting}>
                  {t("common.create")}
                </Button>
              </Modal.Actions>
            </form>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
