import type { ProjectSummary } from "@eevee/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { showToast } from "./toasts.ts";

export type ProjectsStore = {
  readonly projects: readonly ProjectSummary[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly reload: () => Promise<void>;
  readonly upsertProject: (project: ProjectSummary) => void;
  readonly removeProject: (projectId: string) => void;
};

export function useProjectsStore(enabled: boolean): ProjectsStore {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const reload = useCallback(async () => {
    if (!enabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const res = await api.listProjects(controller.signal);
      if (controller.signal.aborted) return;
      setProjects(res.projects);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(t("overview.loadError", { error: message }), "danger");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      abortRef.current = undefined;
      setProjects([]);
      setLoading(false);
      setError(undefined);
      return;
    }
    void reload();
    return () => {
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [enabled, reload]);

  const upsertProject = useCallback((project: ProjectSummary) => {
    setProjects((prev) => {
      const idx = prev.findIndex((item) => item.id === project.id);
      if (idx === -1) return [project, ...prev];
      const next = [...prev];
      next[idx] = project;
      return next;
    });
  }, []);

  const removeProject = useCallback((projectId: string) => {
    setProjects((prev) => prev.filter((item) => item.id !== projectId));
  }, []);

  return { projects, loading, error, reload, upsertProject, removeProject };
}
