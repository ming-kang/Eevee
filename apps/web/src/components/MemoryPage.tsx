import { Button } from "@earendil-works/elanor-react";
import type { ProjectSummary } from "@eevee/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { SHORTCUT_PRIORITY, useShortcutLayer } from "../lib/shortcut-stack.ts";
import { showToast } from "../lib/toasts.ts";
import { useAbortableAsync } from "../lib/useAbortableAsync.ts";
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
  const { t } = useI18n();
  const [savedText, setSavedText] = useState(project.memory ?? "");
  const [text, setText] = useState(project.memory ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const { run: runLoadMemory } = useAbortableAsync();

  useEffect(() => {
    setError(undefined);
    void runLoadMemory((signal) => api.getProjectMemory(project.id, signal))
      .then((res) => {
        if (!res) return;
        const val = res.memory ?? "";
        setSavedText(val);
        setText(val);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [project.id, runLoadMemory]);

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
      showToast(t("memory.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, project, text, onProjectUpdated, t]);

  useShortcutLayer({
    id: "memory-save",
    active: true,
    priority: SHORTCUT_PRIORITY.PAGE,
    onKeyDown: (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
        return true;
      }
      return false;
    },
  });

  return (
    <section className="ev-page">
      <ProjectHeader
        project={project}
        view="memory"
        onSelectView={onSelectView}
        onEditProject={onEditProject}
        actions={
          <div className="ev-inline-actions">
            {dirty && (
              <Button
                hierarchy="tertiary"
                density="compact"
                disabled={saving}
                onClick={() => setText(savedText)}
              >
                {t("memory.discard")}
              </Button>
            )}
            <Button
              hierarchy="primary"
              density="compact"
              disabled={!dirty}
              pending={saving}
              onClick={() => void save()}
            >
              {t("common.save")}
            </Button>
          </div>
        }
      />

      {error && (
        <div className="ev-page-banner">
          <div className="ev-error-banner" role="alert">
            {error}
          </div>
        </div>
      )}

      <div className="ev-note-surface">
        <textarea
          className="ev-note-editor"
          aria-label={t("project.tab.memory")}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("memory.placeholder")}
        />
      </div>
    </section>
  );
}
