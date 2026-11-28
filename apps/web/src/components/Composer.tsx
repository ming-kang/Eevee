import {
  AttachFileIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
} from "@earendil-works/elanor-icons-react";
import {
  Button,
  type ComposerActions,
  type ComposerChipDeletion,
  Composer as ElanorComposer,
  Meter,
  SegmentedControl,
  Stack,
} from "@earendil-works/elanor-react";
import {
  type BoardViewPayload,
  type ConversationRef,
  MAX_MESSAGE_ATTACHMENTS,
  type MessageAttachment,
  type ModelChoice,
  type WhenBusy,
} from "@eevee/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { toProtocolAttachments } from "../lib/attachments.ts";
import {
  isMessageEmpty,
  type MessageChip,
  type MessageValue,
  messageText,
} from "../lib/composer-value.ts";
import { formatBytes, formatTokens } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import { findModelInfo } from "../lib/model-choice.ts";
import { showToast } from "../lib/toasts.ts";
import type { ContextUsage } from "../lib/transcript.ts";
import { updateGlobalRouterModel, useEngineSettingsAndModels } from "../lib/useEngineSettings.ts";
import { AttachmentLightbox, type LightboxImage } from "./AttachmentLightbox.tsx";
import { AttachmentPills } from "./AttachmentPills.tsx";
import { ComposerSuggestions } from "./composer/ComposerSuggestions.tsx";
import { MessagePrompt } from "./composer/MessagePrompt.tsx";
import { renderMessageChip } from "./composer/messageChips.tsx";
import { useComposerDraft } from "./composer/useComposerDraft.ts";
import { EvTooltip } from "./EvTooltip.tsx";
import { ModelChoiceMenu } from "./ModelChoiceMenu.tsx";

const CHIP_DELETION: ComposerChipDeletion = "revert";

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

function hasModifier(event: Event | undefined): boolean {
  return event instanceof KeyboardEvent && (event.metaKey || event.ctrlKey);
}

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
  const actionsRef = useRef<ComposerActions<MessageChip> | null>(null);
  const [whenBusy, setWhenBusy] = useState<WhenBusy>("followUp");
  const [submitting, setSubmitting] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | undefined>(undefined);

  useEffect(() => {
    void draftKey;
    setError(undefined);
  }, [draftKey]);

  const describeChip = useCallback(
    (chip: MessageChip) => {
      switch (chip.kind) {
        case "file":
          return `${t("composer.chip.file")}, ${chip.ref}`;
        case "worker":
          return t("composer.chip.worker");
        case "ticket":
          return t("composer.chip.ticket");
        case "skill":
          return t("composer.chip.skill");
      }
    },
    [t],
  );

  const chipRemovedMessage = useCallback(
    (chip: MessageChip) => t("composer.chip.removed", { label: chip.label }),
    [t],
  );

  const chipSelectedMessage = useCallback(
    (chip: MessageChip, key: "Backspace" | "Delete") =>
      t("composer.chip.selected", { label: chip.label, description: describeChip(chip), key }),
    [t, describeChip],
  );

  const submit = async (value: MessageValue, event: Event | undefined) => {
    const text = messageText(value).trim();
    const pendingAttachments = draft.attachmentsRef.current;
    if ((text.length === 0 && pendingAttachments.length === 0) || submitting || disabled) return;
    const mode: WhenBusy =
      busy && hasModifier(event) ? (whenBusy === "steer" ? "followUp" : "steer") : whenBusy;
    const submittedDraftKey = draftKey;

    setSubmitting(true);
    setError(undefined);
    actionsRef.current?.clearHistory();
    draft.updateValue([]);
    draft.updateAttachments([]);

    try {
      await onSend(
        text,
        mode,
        pendingAttachments.length > 0 ? toProtocolAttachments(pendingAttachments) : undefined,
      );
      if (value.length > 0) draft.recordSent(submittedDraftKey, value);
    } catch (err) {
      if (draft.restoreSubmitted(submittedDraftKey, value, pendingAttachments)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (draft.mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  const expandAttachmentToText = (id: string) => {
    const target = draft.attachmentsRef.current.find((item) => item.id === id);
    if (target?.pastedText === undefined) return;
    actionsRef.current?.insert(target.pastedText, { at: "end", startLine: true });
    draft.updateAttachments(draft.attachmentsRef.current.filter((item) => item.id !== id));
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
    (!isMessageEmpty(draft.value) || draft.attachments.length > 0) && !submitting && !disabled;

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
      <ElanorComposer.Root
        value={draft.value}
        onValueChange={draft.updateValue}
        historyKey={draftKey}
        toText={messageText}
        renderChip={renderMessageChip}
        chipDeletion={CHIP_DELETION}
        getChipDescription={describeChip}
        getChipRemovedMessage={chipRemovedMessage}
        getChipSelectedMessage={chipSelectedMessage}
        onSubmit={(value, details) => void submit(value, details.event)}
        onAttach={(files) => void draft.appendFiles(files)}
        getPastedValue={draft.pastedValue}
        disabled={disabled}
        actionsRef={actionsRef}
      >
        <ElanorComposer.Panel className="ev-composer-form">
          {(busy || error) && (
            <ElanorComposer.Header className="ev-composer-header">
              {busy && (
                <div className="ev-composer-busy-banner">
                  <span className="ev-dot" data-stage="working" />
                  <span className="ev-truncate ev-composer-busy-text">
                    {t("composer.busyBanner")}
                  </span>
                  <SegmentedControl.Root
                    density="compact"
                    className="ev-composer-busy-seg"
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
                </div>
              )}
              {error && <div className="ev-error-banner">{error}</div>}
            </ElanorComposer.Header>
          )}

          <ElanorComposer.InputGroup className="ev-composer-frame">
            <div className="ev-composer-drop-overlay">{t("composer.dropHint")}</div>
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
              onExpandToText={expandAttachmentToText}
              onRemove={(id) =>
                draft.updateAttachments(draft.attachments.filter((item) => item.id !== id))
              }
            />

            <MessagePrompt placeholder={placeholder} sentMessages={draft.sentHistory} />

            <ElanorComposer.Controls className="ev-composer-bar">
              <Stack direction="row" gap="xSmall" align="center" className="ev-composer-bar-group">
                <EvTooltip content={t("composer.attach")} side="top">
                  <ElanorComposer.Attach
                    aria-label={t("composer.attach")}
                    disabled={draft.attachments.length >= MAX_MESSAGE_ATTACHMENTS}
                  >
                    <AttachFileIcon width={16} height={16} />
                  </ElanorComposer.Attach>
                </EvTooltip>

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
                    <ElanorComposer.Stop
                      aria-label={t("composer.interrupt")}
                      onClick={() => void runAction(onInterrupt)}
                    >
                      <StopIcon />
                    </ElanorComposer.Stop>
                  </EvTooltip>
                )}
                <ElanorComposer.Submit aria-label={t("composer.send")} disabled={!canSend}>
                  <SendIcon />
                </ElanorComposer.Submit>
              </Stack>
            </ElanorComposer.Controls>
          </ElanorComposer.InputGroup>
        </ElanorComposer.Panel>
        <ComposerSuggestions projectId={projectId} board={board} />
      </ElanorComposer.Root>

      <AttachmentLightbox image={lightboxImage} onClose={() => setLightboxImage(undefined)} />
    </>
  );
}
