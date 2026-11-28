import type {
  ComposerSuggestionMatch,
  ComposerSuggestionResults,
} from "@earendil-works/elanor-react";
import type { BoardViewPayload, SkillEntry, WorkspaceFile } from "@eevee/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import {
  mentionItems,
  type SuggestionItem,
  type SuggestionTarget,
  searchesFiles,
  skillItems,
  suggestionTarget,
} from "../../lib/composer-suggestions.ts";

const SKILLS_CACHE_TTL_MS = 4000;
const FILE_SEARCH_DEBOUNCE_MS = 120;

type CachedSkills = {
  readonly skills: readonly SkillEntry[];
  readonly fetchedAt: number;
};

const skillsCache = new Map<string, CachedSkills>();

function useSkillCatalog(projectId: string | undefined, query: string | undefined) {
  const cacheKey = projectId ?? "__global__";
  const inflightKeyRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const [skills, setSkills] = useState<readonly SkillEntry[] | undefined>(
    () => skillsCache.get(cacheKey)?.skills,
  );
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    abortRef.current?.abort();
    inflightKeyRef.current = undefined;
    setError(undefined);
    setSkills(skillsCache.get(cacheKey)?.skills);
  }, [cacheKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (query === undefined) return;
    const cached = skillsCache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.fetchedAt < SKILLS_CACHE_TTL_MS) {
      setSkills(cached.skills);
      return;
    }
    if (inflightKeyRef.current === cacheKey) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    inflightKeyRef.current = cacheKey;
    setError(undefined);

    const request = projectId
      ? api.skills(projectId).list(controller.signal)
      : api.listSkills(controller.signal);

    void request
      .then((res) => {
        if (controller.signal.aborted) return;
        skillsCache.set(cacheKey, { skills: res.skills, fetchedAt: Date.now() });
        setSkills(res.skills);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted && inflightKeyRef.current === cacheKey) {
          inflightKeyRef.current = undefined;
        }
      });
  }, [query, cacheKey, projectId]);

  return { skills, error };
}

type FileResults = {
  readonly match: ComposerSuggestionMatch;
  readonly files: readonly WorkspaceFile[];
};

function useFileSearch(
  projectId: string | undefined,
  match: ComposerSuggestionMatch | null,
  target: SuggestionTarget | undefined,
) {
  const [results, setResults] = useState<FileResults | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const searching = target !== undefined && searchesFiles(target) && projectId !== undefined;
  const query = searching ? target.query : undefined;

  useEffect(() => {
    if (query === undefined || match === null || projectId === undefined) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(() => {
      void api
        .listProjectFiles(projectId, { q: query, limit: 24, signal: controller.signal })
        .then((res) => {
          if (!controller.signal.aborted) setResults({ match, files: res.files });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResults({ match, files: [] });
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [match, query, projectId]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  return { results: searching ? results : undefined, searching, cancel };
}

export type SuggestionState = {
  readonly target: SuggestionTarget | undefined;
  readonly results: ComposerSuggestionResults<SuggestionItem> | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly cancel: () => void;
};

export function useSuggestionResults(
  projectId: string | undefined,
  board: BoardViewPayload | undefined,
  match: ComposerSuggestionMatch | null,
): SuggestionState {
  const target = match ? suggestionTarget(match) : undefined;
  const catalog = useSkillCatalog(projectId, target?.kind === "skill" ? target.query : undefined);
  const fileSearch = useFileSearch(projectId, match, target);

  if (!match || !target) {
    return {
      target,
      results: undefined,
      loading: false,
      error: undefined,
      cancel: fileSearch.cancel,
    };
  }

  if (target.kind === "skill") {
    return {
      target,
      results: { match, items: catalog.skills ? skillItems(catalog.skills, target.query) : [] },
      loading: catalog.skills === undefined && catalog.error === undefined,
      error: catalog.skills === undefined ? catalog.error : undefined,
      cancel: fileSearch.cancel,
    };
  }

  if (!fileSearch.searching) {
    return {
      target,
      results: { match, items: mentionItems([], board, target.query, target.scope) },
      loading: false,
      error: undefined,
      cancel: fileSearch.cancel,
    };
  }

  const answered = fileSearch.results;
  const answeredTarget = answered ? suggestionTarget(answered.match) : undefined;
  return {
    target,
    results:
      answered && answeredTarget?.kind === "mention"
        ? {
            match: answered.match,
            items: mentionItems(answered.files, board, answeredTarget.query, answeredTarget.scope),
          }
        : undefined,
    loading: answered?.match !== match,
    error: undefined,
    cancel: fileSearch.cancel,
  };
}
