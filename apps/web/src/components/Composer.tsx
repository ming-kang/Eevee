import {
  AttachFileIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, IconButton, Meter, SegmentedControl, Stack } from "@earendil-works/elanor-react";
import {
  type BoardViewPayload,
  type ConversationRef,
  MAX_MESSAGE_ATTACHMENTS,
  type MessageAttachment,
  type ModelChoice,
  type WhenBusy,
} from "@eevee/protocol";
import {
  type FormEvent,
  type KeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { toProtocolAttachments } from "../lib/attachments.ts";
import { formatBytes, formatTokens } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import { findModelInfo } from "../lib/model-choice.ts";
import { showToast } from "../lib/toasts.ts";
import type { ContextUsage } from "../lib/transcript.ts";
import { updateGlobalRouterModel, useEngineSettingsAndModels } from "../lib/useEngineSettings.ts";
import { AttachmentLightbox, type LightboxImage } from "./AttachmentLightbox.tsx";
import { AttachmentPills } from "./AttachmentPills.tsx";
import { ComposerAutocompleteMenu } from "./composer/ComposerAutocompleteMenu.tsx";
import { useComposerAutocomplete } from "./composer/useComposerAutocomplete.ts";
import { useComposerDraft } from "./composer/useComposerDraft.ts";
import { EvTooltip } from "./EvTooltip.tsx";
import { ModelChoiceMenu } from "./ModelChoiceMenu.tsx";

export type ComposerProps = {
  readonly draftKey: string;
  readonly projectId?: string;
  readonly board?: BoardViewPayload;
  readonly activeRef: ConversationRef;
  readonly busy: boolean;
  readonly hasRunFailure: boolean;
  readonly disabled?: boolean;
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
  contextUsage,
  modelLabel,
  onSend,
  onInterrupt,
  onRetry,
}: ComposerProps) {
  const { t } = useI18n();
  const isRouterComposer = activeRef === "router";
  const {
    settings: globalSettings,
    availableModels,
    refresh: refreshModels,
  } = useEngineSettingsAndModels(isRouterComposer);

  const draft = useComposerDraft(draftKey, disabled);
  const [whenBusy, setWhenBusy] = useState<WhenBusy>("followUp");
  const [submitting, setSubmitting] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [cursorOffset, setCursorOffset] = useState(() => draft.text.length);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | undefined>(undefined);

  const formRef = useRef<HTMLFormElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const autocomplete = useComposerAutocomplete({
    projectId,
    board,
    text: draft.text,
    cursorOffset,
    disabled,
    formRef,
    textareaRef,
    onReplaceText: (nextText, nextCursor) => {
      draft.updateText(nextText);
      setCursorOffset(nextCursor);
    },
  });

  const resetAutocompleteDismissed = autocomplete.resetDismissed;
  const draftTextRef = draft.textRef;
  useEffect(() => {
    void draftKey;
    setCursorOffset(draftTextRef.current.length);
    resetAutocompleteDismissed();
    setError(undefined);
  }, [draftKey, draftTextRef, resetAutocompleteDismissed]);

  useEffect(() => {
    void draft.text;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft.text]);

  const syncCursor = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const pos = event.currentTarget.selectionStart;
    if (typeof pos === "number") setCursorOffset(pos);
  };

  const submit = async (overrideMode?: WhenBusy) => {
    const trimmed = draft.text.trim();
    const pendingAttachments = draft.attachmentsRef.current;
    if ((trimmed.length === 0 && pendingAttachments.length === 0) || submitting || disabled) return;
    const submittedText = draft.text;
    const submittedDraftKey = draftKey;
    const submittedAttachments = pendingAttachments;

    setSubmitting(true);
    setError(undefined);
    draft.updateText("");
    draft.updateAttachments([]);
    setCursorOffset(0);
    autocomplete.resetDismissed();

    try {
      await onSend(
        trimmed,
        overrideMode ?? whenBusy,
        submittedAttachments.length > 0 ? toProtocolAttachments(submittedAttachments) : undefined,
      );
    } catch (err) {
      const outcome = draft.restoreSubmitted(
        submittedDraftKey,
        submittedText,
        submittedAttachments,
      );
      if (outcome.restoredCurrent) {
        setError(err instanceof Error ? err.message : String(err));
        if (outcome.cursorToEnd !== undefined) {
          setCursorOffset(outcome.cursorToEnd);
        }
      }
    } finally {
      if (draft.mountedRef.current) {
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
    if (autocomplete.handleKeyDown(event)) return;

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
      if (draft.mountedRef.current) setSwitchingModel(false);
    }
  };

  const placeholder =
    activeRef === "router"
      ? busy
        ? t("composer.placeholder.routerBusy")
        : t("composer.placeholder.router")
      : t("composer.placeholder.worker", { ref: activeRef });

  const canSend =
    (draft.text.trim().length > 0 || draft.attachments.length > 0) && !submitting && !disabled;

  const activeModelInfo = isRouterComposer
    ? findModelInfo(availableModels, globalSettings?.models?.router)
    : undefined;
  const contextWindow = activeModelInfo?.contextWindow;
  const ctxPct =
    contextUsage && contextWindow && contextWindow > 0
      ? Math.min(100, Math.round((contextUsage.used / contextWindow) * 100))
      : undefined;
  const ctxSemantic =
    ctxPct !== undefined && ctxPct >= 90
      ? "negative"
      : ctxPct !== undefined && ctxPct >= 75
        ? "warning"
        : "neutral";

  return (
    <>
      <form
        ref={formRef}
        className={`ev-composer-form${draft.dragging ? " dragging" : ""}`}
        onSubmit={handleSubmit}
        onDragEnter={draft.handleDragEnter}
        onDragOver={draft.handleDragOver}
        onDragLeave={draft.handleDragLeave}
        onDrop={draft.handleDrop}
      >
        {draft.dragging && <div className="ev-composer-drop-overlay">{t("composer.dropHint")}</div>}

        <ComposerAutocompleteMenu
          skillPopoverOpen={autocomplete.skillPopoverOpen}
          mentionPopoverOpen={autocomplete.mentionPopoverOpen}
          skills={autocomplete.skills}
          matchingSkills={autocomplete.matchingSkills}
          loadingSkills={autocomplete.loadingSkills}
          skillsError={autocomplete.skillsError}
          mentionOptions={autocomplete.mentionOptions}
          loadingMentions={autocomplete.loadingMentions}
          safeIndex={autocomplete.safeIndex}
          optionRefs={autocomplete.optionRefs}
          onHoverIndex={autocomplete.setActiveIndex}
          onSelectSkill={autocomplete.selectSkill}
          onSelectMention={autocomplete.selectMention}
        />

        {error && <div className="ev-error-banner">{error}</div>}

        <AttachmentPills
          attachments={draft.attachments}
          onPreview={(att) =>
            att.previewUrl
              ? setLightboxImage({
                  src: att.previewUrl,
                  alt: att.name,
                  caption: `${att.name} (${formatBytes(att.size)})`,
                })
              : undefined
          }
          onRemove={(id) =>
            draft.updateAttachments(draft.attachments.filter((item) => item.id !== id))
          }
        />

        <textarea
          ref={textareaRef}
          className="ev-composer-textarea"
          rows={2}
          value={draft.text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => {
            const nextValue = event.target.value;
            const pos = event.target.selectionStart;
            draft.updateText(nextValue);
            if (typeof pos === "number") setCursorOffset(pos);
          }}
          onPaste={draft.handlePaste}
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
              void draft.appendFiles(event.target.files);
            }
            event.target.value = "";
          }}
        />

        <div className="ev-composer-bar">
          <Stack direction="row" gap="xSmall" align="center" className="ev-composer-bar-group">
            <EvTooltip content={t("composer.attach")} side="top">
              <IconButton
                type="button"
                aria-label={t("composer.attach")}
                disabled={disabled || draft.attachments.length >= MAX_MESSAGE_ATTACHMENTS}
                onClick={() => fileInputRef.current?.click()}
              >
                <AttachFileIcon width={16} height={16} />
              </IconButton>
            </EvTooltip>

            {busy && (
              <SegmentedControl.Root
                density="compact"
                value={[whenBusy]}
                onValueChange={(values) => {
                  const v = values[0];
                  if (v === "followUp" || v === "steer") setWhenBusy(v);
                }}
              >
                <EvTooltip content={t("composer.mode.followUpHint")} side="top">
                  <SegmentedControl.Item value="followUp">
                    {t("composer.mode.followUp")}
                  </SegmentedControl.Item>
                </EvTooltip>
                <EvTooltip content={t("composer.mode.steerHint")} side="top">
                  <SegmentedControl.Item value="steer">
                    {t("composer.mode.steer")}
                  </SegmentedControl.Item>
                </EvTooltip>
              </SegmentedControl.Root>
            )}

            {isRouterComposer && (
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
            )}
          </Stack>

          <Stack direction="row" gap="xSmall" align="center" className="ev-push-end">
            {contextUsage && (
              <EvTooltip
                content={t("composer.ctxTooltip", {
                  used: formatTokens(contextUsage.used),
                  cached: formatTokens(contextUsage.cached),
                })}
                side="top"
              >
                <span className="ev-mono ev-num ev-composer-meta">
                  <span>CTX {formatTokens(contextUsage.used)}</span>
                  {contextWindow !== undefined && contextWindow > 0 && (
                    <Meter.Root
                      className="ev-composer-meter"
                      value={Math.min(contextUsage.used, contextWindow)}
                      min={0}
                      max={contextWindow}
                      semantic={ctxSemantic}
                      aria-label={`Context ${ctxPct ?? 0}%`}
                    >
                      <Meter.Track>
                        <Meter.Indicator />
                      </Meter.Track>
                    </Meter.Root>
                  )}
                </span>
              </EvTooltip>
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
              <EvTooltip content={t("composer.interruptTitle")} side="top">
                <button
                  type="button"
                  className="ev-round-btn stop"
                  aria-label={t("composer.interrupt")}
                  onClick={() => void runAction(onInterrupt)}
                >
                  <StopIcon width={15} height={15} />
                </button>
              </EvTooltip>
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
