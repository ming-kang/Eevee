import { Button, TextArea } from "@earendil-works/elanor-react";
import type { ProjectSummary } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { showToast } from "../lib/toasts.ts";
import { ProjectHeader } from "./ProjectHeader.tsx";

export function MemoryPage({
  project,
  onSelectView,
  onEditProject,
  onProjectUpdated,
}: {
  readonly project: ProjectSummary;
  readonly onSelectView: (view: "chat" | "memory" | "usage") => void;
  readonly onEditProject: () => void;
  readonly onProjectUpdated: (project: ProjectSummary) => void;
}) {
  const [savedText, setSavedText] = useState(project.memory ?? "");
  const [text, setText] = useState(project.memory ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setError(undefined);
    void api
      .getProjectMemory(project.id)
      .then((res) => {
        if (!active) return;
        const val = res.memory ?? "";
        setSavedText(val);
        setText(val);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [project.id]);

  const dirty = text !== savedText;

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const res = await api.putProjectMemory(project.id, {
        memory: text.trim().length > 0 ? text : null,
      });
      const next = res.memory ?? "";
      setSavedText(next);
      setText(next);
      onProjectUpdated({
        ...project,
        ...(res.memory ? { memory: res.memory } : { memory: undefined }),
      });
      showToast("项目记忆已保存，下次请求立即生效");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, project, text, onProjectUpdated]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  return (
    <section style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <ProjectHeader
        project={project}
        view="memory"
        onSelectView={onSelectView}
        onEditProject={onEditProject}
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {dirty && (
              <Button
                hierarchy="tertiary"
                density="compact"
                disabled={saving}
                onClick={() => setText(savedText)}
              >
                放弃更改
              </Button>
            )}
            <Button
              hierarchy="primary"
              density="compact"
              disabled={!dirty}
              pending={saving}
              onClick={() => void save()}
            >
              保存
            </Button>
          </div>
        }
      />

      <div className="ev-page-scroll">
        <div className="ev-page-narrow">
          {error && <div className="ev-error-banner">{error}</div>}
          <TextArea
            rows={20}
            value={text}
            onValueChange={(val) => setText(val)}
            placeholder="项目背景、约定与约束…"
          />
        </div>
      </div>
    </section>
  );
}
