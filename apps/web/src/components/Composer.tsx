import { RefreshIcon, SendIcon, StopIcon } from "@earendil-works/elanor-icons-react";
import { Button, SegmentedControl, Stack } from "@earendil-works/elanor-react";
import type { ConversationRef, SkillEntry, WhenBusy } from "@eevee/protocol";
import {
  type FormEvent,
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../lib/api.ts";
import {
  draftStorageKey,
  restoreFailedDraft,
  restoreFailedDraftToStorage,
} from "../lib/composer-draft.ts";
import { formatTokens } from "../lib/format.ts";
import {
  applySkillAutocomplete,
  extractSkillAutocompleteToken,
  filterAutocompleteSkills,
} from "../lib/skill-autocomplete.ts";
import type { ContextUsage } from "../lib/transcript.ts";

const SKILLS_CACHE_TTL_MS = 4000;

type CachedSkills = {
  readonly skills: readonly SkillEntry[];
  readonly fetchedAt: number;
};

const skillsCache = new Map<string, CachedSkills>();

export type ComposerProps = {
  readonly draftKey: string;
  readonly projectId?: string;
  readonly activeRef: ConversationRef;
  readonly busy: boolean;
  readonly hasRunFailure: boolean;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly contextUsage?: ContextUsage;
  readonly modelLabel?: string;
  readonly onSend: (text: string, whenBusy: WhenBusy) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
};

export function Composer({
  draftKey,
  projectId,
  activeRef,
  busy,
  hasRunFailure,
  disabled = false,
  compact = false,
  contextUsage,
  modelLabel,
  onSend,
  onInterrupt,
  onRetry,
}: ComposerProps) {
  const [text, setText] = useState(() => {
    try {
      return window.localStorage.getItem(draftStorageKey(draftKey)) ?? "";
    } catch {
      return "";
    }
  });
  const textRef = useRef(text);
  textRef.current = text;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const mountedRef = useRef(true);
  const [whenBusy, setWhenBusy] = useState<WhenBusy>("followUp");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [cursorOffset, setCursorOffset] = useState(() => text.length);
  const [dismissedTokenKey, setDismissedTokenKey] = useState<string | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);

  const cacheKey = projectId ?? "__global__";
  const inflightKeyRef = useRef<string | undefined>(undefined);
  const skillsAbortRef = useRef<AbortController | undefined>(undefined);
  const [skills, setSkills] = useState<readonly SkillEntry[]>(
    () => skillsCache.get(cacheKey)?.skills ?? [],
  );
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [skillsError, setSkillsError] = useState<string | undefined>(undefined);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    draftKeyRef.current = draftKey;
    let nextDraft = "";
    try {
      nextDraft = window.localStorage.getItem(draftStorageKey(draftKey)) ?? "";
    } catch {
      nextDraft = "";
    }
    textRef.current = nextDraft;
    setText(nextDraft);
    setCursorOffset(nextDraft.length);
    setDismissedTokenKey(undefined);
    setError(undefined);
  }, [draftKey]);

  useEffect(() => {
    skillsAbortRef.current?.abort();
    inflightKeyRef.current = undefined;
    setLoadingSkills(false);
    setSkillsError(undefined);
    setSkills(skillsCache.get(cacheKey)?.skills ?? []);
  }, [cacheKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      skillsAbortRef.current?.abort();
    };
  }, []);

  const updateText = useCallback(
    (next: string) => {
      textRef.current = next;
      setText(next);
      try {
        const key = draftStorageKey(draftKey);
        if (next) window.localStorage.setItem(key, next);
        else window.localStorage.removeItem(key);
      } catch {}
    },
    [draftKey],
  );

  useEffect(() => {
    void text;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, compact ? 130 : 200)}px`;
  }, [text, compact]);

  const token = useMemo(
    () => extractSkillAutocompleteToken(text, cursorOffset),
    [text, cursorOffset],
  );
  const tokenKey = token ? `${token.start}:${token.end}:${token.query}` : undefined;
  const popoverOpen = !disabled && token !== undefined && tokenKey !== dismissedTokenKey;

  useEffect(() => {
    if (!token || disabled) return;
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
  }, [token, disabled, cacheKey, projectId]);

  const matchingSkills = useMemo(
    () => (token ? filterAutocompleteSkills(skills, token.query) : []),
    [skills, token],
  );

  const safeIndex =
    matchingSkills.length === 0 ? 0 : Math.min(activeIndex, matchingSkills.length - 1);

  useEffect(() => {
    void tokenKey;
    setActiveIndex(0);
  }, [tokenKey]);

  useEffect(() => {
    if (!popoverOpen) return;
    optionRefs.current[safeIndex]?.scrollIntoView({ block: "nearest" });
  }, [popoverOpen, safeIndex]);

  const syncCursor = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const pos = event.currentTarget.selectionStart;
    if (typeof pos === "number") setCursorOffset(pos);
  };

  const selectSkill = (skill: SkillEntry) => {
    if (!token) return;
    const { nextText, nextCursor } = applySkillAutocomplete(text, token, skill.name);
    setDismissedTokenKey(undefined);
    updateText(nextText);
    setCursorOffset(nextCursor);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const submit = async (overrideMode?: WhenBusy) => {
    const trimmed = text.trim();
    if (!trimmed || submitting || disabled) return;
    const submittedText = text;
    const submittedDraftKey = draftKey;
    setSubmitting(true);
    setError(undefined);
    updateText("");
    setCursorOffset(0);
    setDismissedTokenKey(undefined);
    try {
      await onSend(trimmed, overrideMode ?? whenBusy);
    } catch (err) {
      if (mountedRef.current && draftKeyRef.current === submittedDraftKey) {
        setError(err instanceof Error ? err.message : String(err));
        const wasEmpty = textRef.current === "";
        const restored = restoreFailedDraft(submittedText, textRef.current);
        updateText(restored);
        if (wasEmpty) {
          setCursorOffset(restored.length);
        }
      } else {
        try {
          restoreFailedDraftToStorage(window.localStorage, submittedDraftKey, submittedText);
        } catch {}
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (popoverOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedTokenKey(tokenKey);
        return;
      }
      if (matchingSkills.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((prev) => (prev + 1) % matchingSkills.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((prev) => (prev - 1 + matchingSkills.length) % matchingSkills.length);
          return;
        }
        if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
          const chosen = matchingSkills[safeIndex];
          if (chosen) selectSkill(chosen);
          return;
        }
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (busy && (event.metaKey || event.ctrlKey)) {
        void submit(whenBusy === "steer" ? "followUp" : "steer");
      } else {
        void submit();
      }
    }
  };

  const runAction = async (fn: () => Promise<void>) => {
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const placeholder =
    activeRef === "router"
      ? busy
        ? "继续指示 Router…"
        : "发消息给 Router…"
      : `发消息给 ${activeRef}…`;

  return (
    <form className={`ev-composer-form${compact ? " compact" : ""}`} onSubmit={handleSubmit}>
      {popoverOpen && (
        <div className="ev-skill-autocomplete" role="listbox" aria-label="Skills 自动补全">
          <div className="ev-skill-ac-head">
            <span>选择 Skill</span>
            <span className="ev-skill-ac-keys ev-mono">↑↓ · Tab/↵ · Esc</span>
          </div>
          {loadingSkills && skills.length === 0 ? (
            <div className="ev-skill-ac-empty">加载 Skills…</div>
          ) : skillsError && skills.length === 0 ? (
            <div className="ev-skill-ac-empty ev-inline-error">{skillsError}</div>
          ) : matchingSkills.length === 0 ? (
            <div className="ev-skill-ac-empty">未找到匹配的可用 Skill</div>
          ) : (
            <div className="ev-skill-ac-list">
              {matchingSkills.map((skill, idx) => (
                <button
                  key={`${skill.name}:${skill.path}`}
                  ref={(el) => {
                    optionRefs.current[idx] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={idx === safeIndex}
                  className="ev-skill-ac-item"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => selectSkill(skill)}
                >
                  <div className="ev-skill-ac-row">
                    <span className="ev-mono ev-skill-ac-name">/skill:{skill.name}</span>
                    {skill.effectiveMode === "user" && (
                      <span className="eevee-badge" data-tone="warning">
                        仅用户
                      </span>
                    )}
                    <span
                      className="eevee-badge"
                      data-tone={skill.source === "workspace" ? "info" : undefined}
                    >
                      {skill.source === "workspace" ? "项目" : "全局"}
                    </span>
                  </div>
                  {skill.description && (
                    <div className="ev-skill-ac-desc ev-truncate">{skill.description}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div className="ev-error-banner">{error}</div>}
      <textarea
        ref={textareaRef}
        className="ev-composer-textarea"
        rows={compact ? 1 : 2}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          const nextValue = event.target.value;
          const pos = event.target.selectionStart;
          updateText(nextValue);
          if (typeof pos === "number") setCursorOffset(pos);
        }}
        onClick={syncCursor}
        onKeyUp={syncCursor}
        onSelect={syncCursor}
        onFocus={syncCursor}
        onKeyDown={handleKeyDown}
      />
      <div className="ev-composer-bar">
        <Stack direction="row" gap="xSmall" align="center" style={{ flexWrap: "wrap" }}>
          {busy && (
            <SegmentedControl.Root
              density="compact"
              value={[whenBusy]}
              onValueChange={(values) => {
                const v = values[0];
                if (v === "followUp" || v === "steer") setWhenBusy(v);
              }}
            >
              <SegmentedControl.Item value="followUp">排队</SegmentedControl.Item>
              <SegmentedControl.Item value="steer">插入</SegmentedControl.Item>
            </SegmentedControl.Root>
          )}
          {!compact && modelLabel && (
            <span className="ev-mono" style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)" }}>
              {modelLabel}
            </span>
          )}
        </Stack>

        <Stack direction="row" gap="xSmall" align="center">
          {contextUsage && (
            <span
              className="ev-mono ev-num"
              style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)" }}
              title={`上下文 ${formatTokens(contextUsage.used)}（缓存命中 ${formatTokens(contextUsage.cached)}）`}
            >
              CTX {formatTokens(contextUsage.used)}
            </span>
          )}
          {hasRunFailure && !busy && (
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              iconStart={<RefreshIcon width={15} height={15} />}
              onClick={() => void runAction(onRetry)}
            >
              重试
            </Button>
          )}
          {busy && (
            <button
              type="button"
              className="ev-round-btn stop"
              aria-label="打断本轮执行"
              title="打断本轮执行（Esc Esc）"
              onClick={() => void runAction(onInterrupt)}
            >
              <StopIcon width={15} height={15} />
            </button>
          )}
          <button
            type="submit"
            className="ev-round-btn send"
            aria-label="发送"
            title="发送（Enter）"
            disabled={disabled || submitting || text.trim().length === 0}
          >
            <SendIcon width={15} height={15} />
          </button>
        </Stack>
      </div>
    </form>
  );
}
