import {
  AttachFileIcon,
  DescriptionIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, IconButton, SegmentedControl, Stack } from "@earendil-works/elanor-react";
import {
  type BoardViewPayload,
  type ConversationRef,
  MAX_MESSAGE_ATTACHMENTS,
  type MessageAttachment,
  type ModelChoice,
  type SkillEntry,
  type WhenBusy,
  type WorkspaceFile,
} from "@eevee/protocol";
import {
  type ClipboardEvent,
  type DragEvent,
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
  type AttachmentValidationIssue,
  type DraftAttachment,
  getDraftAttachments,
  readFilesAsDraftAttachments,
  restoreFailedAttachments,
  setDraftAttachments,
  toProtocolAttachments,
} from "../lib/attachments.ts";
import {
  draftStorageKey,
  restoreFailedDraft,
  restoreFailedDraftToStorage,
} from "../lib/composer-draft.ts";
import { formatBytes, formatTokens } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import {
  applyMentionAutocomplete,
  extractMentionToken,
  filterBoardMentions,
} from "../lib/mention-autocomplete.ts";
import {
  applySkillAutocomplete,
  extractSkillAutocompleteToken,
  filterAutocompleteSkills,
} from "../lib/skill-autocomplete.ts";
import { showToast } from "../lib/toasts.ts";
import type { ContextUsage } from "../lib/transcript.ts";
import { updateGlobalRouterModel, useEngineSettingsAndModels } from "../lib/useEngineSettings.ts";
import { AttachmentLightbox, type LightboxImage } from "./AttachmentLightbox.tsx";
import { AttachmentPills } from "./AttachmentPills.tsx";
import { ModelChoiceMenu } from "./ModelChoiceMenu.tsx";

const SKILLS_CACHE_TTL_MS = 4000;
const MENTION_FETCH_DEBOUNCE_MS = 120;

type CachedSkills = {
  readonly skills: readonly SkillEntry[];
  readonly fetchedAt: number;
};

const skillsCache = new Map<string, CachedSkills>();

type MentionOption =
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

export type ComposerProps = {
  readonly draftKey: string;
  readonly projectId?: string;
  readonly board?: BoardViewPayload;
  readonly activeRef: ConversationRef;
  readonly busy: boolean;
  readonly hasRunFailure: boolean;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly contextUsage?: ContextUsage;
  readonly modelLabel?: string;
  readonly onSend: (
    text: string,
    whenBusy: WhenBusy,
    attachments?: readonly MessageAttachment[],
  ) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
};

export function Composer({
  draftKey,
  projectId,
  board,
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
  const { t } = useI18n();
  const isRouterComposer = activeRef === "router" && !compact;
  const {
    settings: globalSettings,
    availableModels,
    refresh: refreshModels,
  } = useEngineSettingsAndModels(isRouterComposer);

  const [text, setText] = useState(() => {
    try {
      return window.localStorage.getItem(draftStorageKey(draftKey)) ?? "";
    } catch {
      return "";
    }
  });
  const [attachments, setAttachmentsState] = useState<readonly DraftAttachment[]>(() =>
    getDraftAttachments(draftKey),
  );
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const mountedRef = useRef(true);

  const [whenBusy, setWhenBusy] = useState<WhenBusy>("followUp");
  const [submitting, setSubmitting] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [cursorOffset, setCursorOffset] = useState(() => text.length);
  const [dismissedSkillKey, setDismissedSkillKey] = useState<string | undefined>(undefined);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | undefined>(undefined);

  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

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

  const updateAttachments = useCallback((next: readonly DraftAttachment[]) => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
    setDraftAttachments(draftKeyRef.current, next);
  }, []);

  useEffect(() => {
    draftKeyRef.current = draftKey;
    let nextDraft = "";
    try {
      nextDraft = window.localStorage.getItem(draftStorageKey(draftKey)) ?? "";
    } catch {
      nextDraft = "";
    }
    const nextAttachments = getDraftAttachments(draftKey);
    textRef.current = nextDraft;
    attachmentsRef.current = nextAttachments;
    setText(nextDraft);
    setAttachmentsState(nextAttachments);
    setCursorOffset(nextDraft.length);
    setDismissedSkillKey(undefined);
    setDismissedMentionKey(undefined);
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
      mentionAbortRef.current?.abort();
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
    setActiveIndex(0);
  }, [skillTokenKey, mentionTokenKey]);

  useEffect(() => {
    if (!skillPopoverOpen && !mentionPopoverOpen) return;
    optionRefs.current[safeIndex]?.scrollIntoView({ block: "nearest" });
  }, [skillPopoverOpen, mentionPopoverOpen, safeIndex]);

  const syncCursor = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const pos = event.currentTarget.selectionStart;
    if (typeof pos === "number") setCursorOffset(pos);
  };

  const selectSkill = (skill: SkillEntry) => {
    if (!skillToken) return;
    const { nextText, nextCursor } = applySkillAutocomplete(text, skillToken, skill.name);
    setDismissedSkillKey(undefined);
    updateText(nextText);
    setCursorOffset(nextCursor);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const selectMention = (option: MentionOption) => {
    if (!mentionToken) return;
    const { nextText, nextCursor } = applyMentionAutocomplete(text, mentionToken, option.value);
    setDismissedMentionKey(undefined);
    updateText(nextText);
    setCursorOffset(nextCursor);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const reportAttachmentIssues = useCallback(
    (issues: readonly AttachmentValidationIssue[]) => {
      for (const issue of issues) {
        if (issue.kind === "too_many") {
          showToast(t("composer.attachment.tooMany", { max: issue.max }), "danger");
        } else if (issue.kind === "too_large") {
          showToast(
            t("composer.attachment.tooLarge", {
              name: issue.name,
              max: formatBytes(issue.maxBytes),
            }),
            "danger",
          );
        } else {
          showToast(t("composer.attachment.readError", { name: issue.name }), "danger");
        }
      }
    },
    [t],
  );

  const appendFiles = useCallback(
    async (files: FileList | readonly File[]) => {
      if (disabled || files.length === 0) return;
      const result = await readFilesAsDraftAttachments(files, attachmentsRef.current.length);
      if (!mountedRef.current) return;
      if (result.attachments.length > 0) {
        updateAttachments([...attachmentsRef.current, ...result.attachments]);
      }
      if (result.issues.length > 0) {
        reportAttachmentIssues(result.issues);
      }
    },
    [disabled, updateAttachments, reportAttachmentIssues],
  );

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const pastedFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      event.preventDefault();
      void appendFiles(pastedFiles);
    }
  };

  const handleDragEnter = (event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  };

  const handleDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    if (event.dataTransfer.files.length > 0) {
      void appendFiles(event.dataTransfer.files);
    }
  };

  const submit = async (overrideMode?: WhenBusy) => {
    const trimmed = text.trim();
    const pendingAttachments = attachmentsRef.current;
    if ((trimmed.length === 0 && pendingAttachments.length === 0) || submitting || disabled) return;
    const submittedText = text;
    const submittedDraftKey = draftKey;
    const submittedAttachments = pendingAttachments;

    setSubmitting(true);
    setError(undefined);
    updateText("");
    updateAttachments([]);
    setCursorOffset(0);
    setDismissedSkillKey(undefined);
    setDismissedMentionKey(undefined);

    try {
      await onSend(
        trimmed,
        overrideMode ?? whenBusy,
        submittedAttachments.length > 0 ? toProtocolAttachments(submittedAttachments) : undefined,
      );
    } catch (err) {
      if (mountedRef.current && draftKeyRef.current === submittedDraftKey) {
        setError(err instanceof Error ? err.message : String(err));
        const wasEmpty = textRef.current === "";
        const restored = restoreFailedDraft(submittedText, textRef.current);
        updateText(restored);
        if (submittedAttachments.length > 0) {
          const restoredAtts = restoreFailedAttachments(submittedDraftKey, submittedAttachments);
          attachmentsRef.current = restoredAtts;
          setAttachmentsState(restoredAtts);
        }
        if (wasEmpty) {
          setCursorOffset(restored.length);
        }
      } else {
        try {
          restoreFailedDraftToStorage(window.localStorage, submittedDraftKey, submittedText);
        } catch {}
        if (submittedAttachments.length > 0) {
          restoreFailedAttachments(submittedDraftKey, submittedAttachments);
        }
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

    if (skillPopoverOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedSkillKey(skillTokenKey);
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

    if (mentionPopoverOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedMentionKey(mentionTokenKey);
        return;
      }
      if (mentionOptions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((prev) => (prev + 1) % mentionOptions.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((prev) => (prev - 1 + mentionOptions.length) % mentionOptions.length);
          return;
        }
        if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
          const chosen = mentionOptions[safeIndex];
          if (chosen) selectMention(chosen);
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

  const handleRouterModelChange = async (next: ModelChoice | undefined) => {
    if (!next) return;
    setSwitchingModel(true);
    try {
      await updateGlobalRouterModel(next);
      showToast(t("modelMenu.updated"));
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      if (mountedRef.current) setSwitchingModel(false);
    }
  };

  const placeholder =
    activeRef === "router"
      ? busy
        ? t("composer.placeholder.routerBusy")
        : t("composer.placeholder.router")
      : t("composer.placeholder.worker", { ref: activeRef });

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !submitting && !disabled;

  return (
    <>
      <form
        className={`ev-composer-form${compact ? " compact" : ""}${dragging ? " dragging" : ""}`}
        onSubmit={handleSubmit}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragging && (
          <div className="ev-composer-drop-overlay">
            {t("composer.dropHint", { max: MAX_MESSAGE_ATTACHMENTS })}
          </div>
        )}

        {skillPopoverOpen && (
          <div
            className="ev-skill-autocomplete"
            role="listbox"
            aria-label={t("composer.skill.title")}
          >
            <div className="ev-skill-ac-head">
              <span>{t("composer.skill.title")}</span>
              <span className="ev-skill-ac-keys ev-mono">↑↓ · Tab/↵ · Esc</span>
            </div>
            {loadingSkills && skills.length === 0 ? (
              <div className="ev-skill-ac-empty">{t("composer.skill.loading")}</div>
            ) : skillsError && skills.length === 0 ? (
              <div className="ev-skill-ac-empty ev-inline-error">{skillsError}</div>
            ) : matchingSkills.length === 0 ? (
              <div className="ev-skill-ac-empty">{t("composer.skill.empty")}</div>
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
                          {t("composer.skill.userOnly")}
                        </span>
                      )}
                      <span
                        className="eevee-badge"
                        data-tone={skill.source === "workspace" ? "info" : undefined}
                      >
                        {skill.source === "workspace"
                          ? t("composer.skill.workspace")
                          : t("composer.skill.global")}
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

        {mentionPopoverOpen && (
          <div
            className="ev-skill-autocomplete"
            role="listbox"
            aria-label={t("composer.mention.title")}
          >
            <div className="ev-skill-ac-head">
              <span>{t("composer.mention.title")}</span>
              <span className="ev-skill-ac-keys ev-mono">↑↓ · Tab/↵ · Esc</span>
            </div>
            {loadingMentions && mentionOptions.length === 0 ? (
              <div className="ev-skill-ac-empty">{t("composer.mention.loading")}</div>
            ) : mentionOptions.length === 0 ? (
              <div className="ev-skill-ac-empty">{t("composer.mention.empty")}</div>
            ) : (
              <div className="ev-skill-ac-list">
                {mentionOptions.map((option, idx) => (
                  <button
                    key={option.key}
                    ref={(el) => {
                      optionRefs.current[idx] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={idx === safeIndex}
                    className="ev-skill-ac-item"
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => selectMention(option)}
                  >
                    {option.kind === "file" ? (
                      <div className="ev-skill-ac-row">
                        <DescriptionIcon width={13} height={13} className="ev-attachment-icon" />
                        <span className="ev-mono ev-skill-ac-name ev-truncate">
                          {option.file.name}
                        </span>
                        {option.file.dir && (
                          <span className="ev-skill-ac-desc ev-truncate">{option.file.dir}</span>
                        )}
                        <span className="ev-attachment-size ev-num" style={{ marginLeft: "auto" }}>
                          {formatBytes(option.file.size)}
                        </span>
                      </div>
                    ) : (
                      <div className="ev-skill-ac-row">
                        <span className="ev-chip-id">@{option.value}</span>
                        <span className="ev-truncate ev-skill-ac-name">{option.label}</span>
                        <span className="eevee-badge" style={{ marginLeft: "auto" }}>
                          {option.kind === "worker"
                            ? t("composer.mention.group.workers")
                            : t("composer.mention.group.tickets")}
                        </span>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <div className="ev-error-banner">{error}</div>}

        <AttachmentPills
          attachments={attachments}
          onPreview={(att) =>
            att.previewUrl
              ? setLightboxImage({
                  src: att.previewUrl,
                  alt: att.name,
                  caption: `${att.name} (${formatBytes(att.size)})`,
                })
              : undefined
          }
          onRemove={(id) => updateAttachments(attachments.filter((item) => item.id !== id))}
        />

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
          onPaste={handlePaste}
          onClick={syncCursor}
          onKeyUp={syncCursor}
          onSelect={syncCursor}
          onFocus={syncCursor}
          onKeyDown={handleKeyDown}
        />

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files && event.target.files.length > 0) {
              void appendFiles(event.target.files);
            }
            event.target.value = "";
          }}
        />

        <div className="ev-composer-bar">
          <Stack
            direction="row"
            gap="xSmall"
            align="center"
            style={{ flexWrap: "wrap", minWidth: 0 }}
          >
            <IconButton
              type="button"
              aria-label={t("composer.attach")}
              title={t("composer.attach")}
              disabled={disabled || attachments.length >= MAX_MESSAGE_ATTACHMENTS}
              onClick={() => fileInputRef.current?.click()}
            >
              <AttachFileIcon width={16} height={16} />
            </IconButton>

            {busy && (
              <SegmentedControl.Root
                density="compact"
                value={[whenBusy]}
                onValueChange={(values) => {
                  const v = values[0];
                  if (v === "followUp" || v === "steer") setWhenBusy(v);
                }}
              >
                <SegmentedControl.Item value="followUp">
                  {t("composer.mode.followUp")}
                </SegmentedControl.Item>
                <SegmentedControl.Item value="steer">
                  {t("composer.mode.steer")}
                </SegmentedControl.Item>
              </SegmentedControl.Root>
            )}

            {isRouterComposer ? (
              <ModelChoiceMenu
                value={globalSettings?.models?.router}
                models={availableModels}
                placeholder={modelLabel ?? t("modelMenu.choose")}
                placement="up"
                variant="inline"
                disabled={disabled}
                busy={switchingModel}
                ariaLabel={t("config.routerModel")}
                onOpen={() => void refreshModels(false)}
                onChange={(next) => void handleRouterModelChange(next)}
              />
            ) : (
              !compact &&
              modelLabel && (
                <span
                  className="ev-mono"
                  style={{ fontSize: "0.71875rem", color: "var(--ev-fg-subtle)" }}
                >
                  {modelLabel}
                </span>
              )
            )}
          </Stack>

          <Stack direction="row" gap="xSmall" align="center">
            {contextUsage && (
              <span
                className="ev-mono ev-num"
                style={{ fontSize: "0.71875rem", color: "var(--ev-fg-subtle)" }}
                title={t("composer.ctxTooltip", {
                  used: formatTokens(contextUsage.used),
                  cached: formatTokens(contextUsage.cached),
                })}
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
                {t("common.retry")}
              </Button>
            )}
            {busy && (
              <button
                type="button"
                className="ev-round-btn stop"
                aria-label={t("composer.interrupt")}
                title={t("composer.interruptTitle")}
                onClick={() => void runAction(onInterrupt)}
              >
                <StopIcon width={15} height={15} />
              </button>
            )}
            <button
              type="submit"
              className="ev-round-btn send"
              aria-label={t("composer.send")}
              disabled={!canSend}
            >
              <SendIcon width={15} height={15} />
            </button>
          </Stack>
        </div>
      </form>

      <AttachmentLightbox image={lightboxImage} onClose={() => setLightboxImage(undefined)} />
    </>
  );
}
