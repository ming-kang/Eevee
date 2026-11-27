import type { BoardViewPayload, SkillEntry, WorkspaceFile } from "@eevee/protocol";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../../lib/api.ts";
import {
  applyMentionAutocomplete,
  extractMentionToken,
  filterBoardMentions,
} from "../../lib/mention-autocomplete.ts";
import {
  applySkillAutocomplete,
  extractSkillAutocompleteToken,
  filterAutocompleteSkills,
} from "../../lib/skill-autocomplete.ts";

const SKILLS_CACHE_TTL_MS = 4000;
const MENTION_FETCH_DEBOUNCE_MS = 120;

type CachedSkills = {
  readonly skills: readonly SkillEntry[];
  readonly fetchedAt: number;
};

const skillsCache = new Map<string, CachedSkills>();

export type MentionOption =
  | {
      readonly kind: "file";
      readonly key: string;
      readonly value: string;
      readonly file: WorkspaceFile;
    }
  | {
      readonly kind: "worker";
      readonly key: string;
      readonly value: string;
      readonly label: string;
      readonly status: string;
    }
  | {
      readonly kind: "ticket";
      readonly key: string;
      readonly value: string;
      readonly label: string;
      readonly status: string;
    };

export function useComposerAutocomplete({
  projectId,
  board,
  text,
  cursorOffset,
  disabled,
  formRef,
  textareaRef,
  onReplaceText,
}: {
  readonly projectId: string | undefined;
  readonly board: BoardViewPayload | undefined;
  readonly text: string;
  readonly cursorOffset: number;
  readonly disabled: boolean;
  readonly formRef: RefObject<HTMLFormElement | null>;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly onReplaceText: (nextText: string, nextCursor: number) => void;
}) {
  const [dismissedSkillKey, setDismissedSkillKey] = useState<string | undefined>(undefined);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);

  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const shouldScrollOptionRef = useRef(false);

  const cacheKey = projectId ?? "__global__";
  const inflightKeyRef = useRef<string | undefined>(undefined);
  const skillsAbortRef = useRef<AbortController | undefined>(undefined);
  const [skills, setSkills] = useState<readonly SkillEntry[]>(
    () => skillsCache.get(cacheKey)?.skills ?? [],
  );
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [skillsError, setSkillsError] = useState<string | undefined>(undefined);

  const mentionAbortRef = useRef<AbortController | undefined>(undefined);
  const [mentionFiles, setMentionFiles] = useState<readonly WorkspaceFile[]>([]);
  const [loadingMentions, setLoadingMentions] = useState(false);

  useEffect(() => {
    skillsAbortRef.current?.abort();
    inflightKeyRef.current = undefined;
    setLoadingSkills(false);
    setSkillsError(undefined);
    setSkills(skillsCache.get(cacheKey)?.skills ?? []);
  }, [cacheKey]);

  useEffect(() => {
    return () => {
      skillsAbortRef.current?.abort();
      mentionAbortRef.current?.abort();
    };
  }, []);

  const skillToken = useMemo(
    () => extractSkillAutocompleteToken(text, cursorOffset),
    [text, cursorOffset],
  );
  const skillTokenKey = skillToken
    ? `${skillToken.start}:${skillToken.end}:${skillToken.query}`
    : undefined;
  const skillPopoverOpen =
    !disabled && skillToken !== undefined && skillTokenKey !== dismissedSkillKey;

  const mentionToken = useMemo(
    () => (skillPopoverOpen ? undefined : extractMentionToken(text, cursorOffset)),
    [skillPopoverOpen, text, cursorOffset],
  );
  const mentionTokenKey = mentionToken
    ? `${mentionToken.start}:${mentionToken.end}:${mentionToken.rawQuery}`
    : undefined;
  const mentionPopoverOpen =
    !disabled &&
    !skillPopoverOpen &&
    mentionToken !== undefined &&
    mentionTokenKey !== dismissedMentionKey;

  useEffect(() => {
    if (!skillToken || disabled) return;
    const cached = skillsCache.get(cacheKey);
    const fresh = cached !== undefined && Date.now() - cached.fetchedAt < SKILLS_CACHE_TTL_MS;
    if (fresh) {
      setSkills((prev) => (prev === cached.skills ? prev : cached.skills));
      return;
    }
    if (inflightKeyRef.current === cacheKey) return;

    skillsAbortRef.current?.abort();
    const controller = new AbortController();
    skillsAbortRef.current = controller;
    inflightKeyRef.current = cacheKey;
    if (cached === undefined) setLoadingSkills(true);
    setSkillsError(undefined);

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
        setSkillsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          if (inflightKeyRef.current === cacheKey) inflightKeyRef.current = undefined;
          setLoadingSkills(false);
        }
      });
  }, [skillToken, disabled, cacheKey, projectId]);

  const mentionQuery = mentionToken?.query;
  const mentionScope = mentionToken?.scope;

  useEffect(() => {
    mentionAbortRef.current?.abort();
    if (
      !mentionPopoverOpen ||
      mentionQuery === undefined ||
      !projectId ||
      mentionScope === "workers" ||
      mentionScope === "tickets"
    ) {
      setMentionFiles([]);
      setLoadingMentions(false);
      return;
    }

    const controller = new AbortController();
    mentionAbortRef.current = controller;
    setLoadingMentions(true);
    const timer = window.setTimeout(() => {
      void api
        .listProjectFiles(projectId, { q: mentionQuery, limit: 24, signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          setMentionFiles(res.files);
        })
        .catch(() => {
          if (!controller.signal.aborted) setMentionFiles([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingMentions(false);
        });
    }, MENTION_FETCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mentionPopoverOpen, mentionQuery, mentionScope, projectId]);

  const matchingSkills = useMemo(
    () => (skillToken ? filterAutocompleteSkills(skills, skillToken.query) : []),
    [skills, skillToken],
  );

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (!mentionToken) return [];
    const out: MentionOption[] = [];
    const { workers, tickets } = filterBoardMentions(board, mentionToken.query, mentionToken.scope);
    for (const file of mentionFiles) {
      out.push({
        kind: "file",
        key: `file:${file.workspace}:${file.path}`,
        value: file.label,
        file,
      });
    }
    for (const worker of workers) {
      out.push({
        kind: "worker",
        key: `worker:${worker.id}`,
        value: worker.id,
        label: `${worker.id} · ${worker.name}`,
        status: worker.status,
      });
    }
    for (const ticket of tickets) {
      out.push({
        kind: "ticket",
        key: `ticket:${ticket.id}`,
        value: ticket.id,
        label: `${ticket.id} · ${ticket.title}`,
        status: ticket.status,
      });
    }
    return out;
  }, [mentionToken, mentionFiles, board]);

  const activeListLength = skillPopoverOpen
    ? matchingSkills.length
    : mentionPopoverOpen
      ? mentionOptions.length
      : 0;
  const safeIndex = activeListLength === 0 ? 0 : Math.min(activeIndex, activeListLength - 1);

  useEffect(() => {
    void skillTokenKey;
    void mentionTokenKey;
    shouldScrollOptionRef.current = true;
    setActiveIndex(0);
  }, [skillTokenKey, mentionTokenKey]);

  useEffect(() => {
    if ((!skillPopoverOpen && !mentionPopoverOpen) || !shouldScrollOptionRef.current) return;
    shouldScrollOptionRef.current = false;
    optionRefs.current[safeIndex]?.scrollIntoView({ block: "nearest" });
  }, [skillPopoverOpen, mentionPopoverOpen, safeIndex]);

  useEffect(() => {
    if (!skillPopoverOpen && !mentionPopoverOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && formRef.current?.contains(event.target)) return;
      if (skillPopoverOpen && skillTokenKey) setDismissedSkillKey(skillTokenKey);
      if (mentionPopoverOpen && mentionTokenKey) setDismissedMentionKey(mentionTokenKey);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [skillPopoverOpen, mentionPopoverOpen, skillTokenKey, mentionTokenKey, formRef]);

  const applyAndFocus = useCallback(
    (nextText: string, nextCursor: number) => {
      onReplaceText(nextText, nextCursor);
      window.requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [onReplaceText, textareaRef],
  );

  const selectSkill = useCallback(
    (skill: SkillEntry) => {
      if (!skillToken) return;
      const { nextText, nextCursor } = applySkillAutocomplete(text, skillToken, skill.name);
      setDismissedSkillKey(undefined);
      applyAndFocus(nextText, nextCursor);
    },
    [skillToken, text, applyAndFocus],
  );

  const selectMention = useCallback(
    (option: MentionOption) => {
      if (!mentionToken) return;
      const { nextText, nextCursor } = applyMentionAutocomplete(text, mentionToken, option.value);
      setDismissedMentionKey(undefined);
      applyAndFocus(nextText, nextCursor);
    },
    [mentionToken, text, applyAndFocus],
  );

  const resetDismissed = useCallback(() => {
    setDismissedSkillKey(undefined);
    setDismissedMentionKey(undefined);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (skillPopoverOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setDismissedSkillKey(skillTokenKey);
          return true;
        }
        if (matchingSkills.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            shouldScrollOptionRef.current = true;
            setActiveIndex((prev) => (prev + 1) % matchingSkills.length);
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            shouldScrollOptionRef.current = true;
            setActiveIndex((prev) => (prev - 1 + matchingSkills.length) % matchingSkills.length);
            return true;
          }
          if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
            event.preventDefault();
            event.stopPropagation();
            const chosen = matchingSkills[safeIndex];
            if (chosen) selectSkill(chosen);
            return true;
          }
        }
      }

      if (mentionPopoverOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setDismissedMentionKey(mentionTokenKey);
          return true;
        }
        if (mentionOptions.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            shouldScrollOptionRef.current = true;
            setActiveIndex((prev) => (prev + 1) % mentionOptions.length);
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            shouldScrollOptionRef.current = true;
            setActiveIndex((prev) => (prev - 1 + mentionOptions.length) % mentionOptions.length);
            return true;
          }
          if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
            event.preventDefault();
            event.stopPropagation();
            const chosen = mentionOptions[safeIndex];
            if (chosen) selectMention(chosen);
            return true;
          }
        }
      }

      return false;
    },
    [
      skillPopoverOpen,
      skillTokenKey,
      matchingSkills,
      mentionPopoverOpen,
      mentionTokenKey,
      mentionOptions,
      safeIndex,
      selectSkill,
      selectMention,
    ],
  );

  return {
    skillPopoverOpen,
    mentionPopoverOpen,
    skills,
    matchingSkills,
    loadingSkills,
    skillsError,
    mentionOptions,
    loadingMentions,
    safeIndex,
    optionRefs,
    setActiveIndex,
    selectSkill,
    selectMention,
    resetDismissed,
    handleKeyDown,
  };
}
