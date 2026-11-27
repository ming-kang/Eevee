import { DescriptionIcon } from "@earendil-works/elanor-icons-react";
import { Button, Collapsible } from "@earendil-works/elanor-react";
import type { WorkerId } from "@eevee/protocol";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, shortPath } from "../lib/format.ts";
import { type LocaleKey, useI18n } from "../lib/i18n.ts";
import type { DisplayItem } from "../lib/transcript.ts";
import { AttachmentLightbox, type LightboxImage } from "./AttachmentLightbox.tsx";
import { Markdown } from "./Markdown.tsx";
import { DisclosureLine } from "./transcript/DisclosureLine.tsx";
import { noticeMetaLabel } from "./transcript/noticeMeta.ts";
import { WorkedGroupView } from "./transcript/WorkedGroupView.tsx";

type TranslateFn = (key: LocaleKey, params?: Readonly<Record<string, string | number>>) => string;

type ItemRenderContext = {
  readonly t: TranslateFn;
  readonly onOpenWorker?: (workerId: WorkerId) => void;
  readonly onPreviewImage: (image: LightboxImage) => void;
  readonly highlightKey?: string;
  readonly wrapClass?: string;
  readonly setRootRef: (el: HTMLElement | null) => void;
  readonly revealedEditKey?: string;
  readonly flashEditKey?: string;
};

function mergeClasses(...names: Array<string | undefined>): string | undefined {
  const joined = names.filter(Boolean).join(" ");
  return joined.length > 0 ? joined : undefined;
}

function EditDisclosure({
  item,
  revealed,
  flashing,
  wrapClass,
  setRootRef,
}: {
  readonly item: Extract<DisplayItem, { kind: "edit" }>;
  readonly revealed: boolean;
  readonly flashing: boolean;
  readonly wrapClass?: string;
  readonly setRootRef: (el: HTMLElement | null) => void;
}) {
  const { t } = useI18n();
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    if (revealed) {
      detailsRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [revealed]);

  const setRefs = useCallback(
    (el: HTMLDetailsElement | null) => {
      detailsRef.current = el;
      setRootRef(el);
    },
    [setRootRef],
  );

  const verb =
    item.status === "run"
      ? item.action === "write"
        ? t("transcript.edit.writing")
        : t("transcript.edit.editing")
      : item.action === "write"
        ? t("transcript.edit.wrote")
        : t("transcript.edit.edited");

  return (
    <DisclosureLine
      ref={setRefs}
      itemKey={item.key}
      wrapClass={mergeClasses(wrapClass, flashing ? "flash" : undefined)}
      open={revealed || undefined}
      summary={
        <>
          <span className={item.status === "run" ? "ev-shimmer" : undefined}>{verb}</span>
          <span className="ev-mono ev-truncate ev-proc-summary-mono" title={item.path}>
            {shortPath(item.path)}
          </span>
          {item.status === "err" ? (
            <span className="ev-minus">{t("transcript.failed")}</span>
          ) : (
            (item.added > 0 || item.removed > 0) && (
              <span className="ev-mono ev-num ev-diff-counts">
                {item.added > 0 && <span className="ev-plus">+{item.added}</span>}
                {item.removed > 0 && <span className="ev-minus">−{item.removed}</span>}
              </span>
            )
          )}
        </>
      }
    >
      <div className="ev-proc-body">
        {item.error ? (
          <div className="ev-error-banner">{item.error}</div>
        ) : item.diff.length > 0 ? (
          <div className="ev-diff-box">
            {item.diff.map((line) => (
              <div key={`${item.key}:${line.id}`} className={`ev-diff-line ${line.k}`}>
                <span>{line.k === "add" ? "+" : line.k === "del" ? "−" : " "}</span>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </DisclosureLine>
  );
}

function UserMessageItem({
  item,
  wrapClass,
  setRootRef,
  onPreviewImage,
}: {
  readonly item: Extract<DisplayItem, { kind: "user" }>;
  readonly wrapClass?: string;
  readonly setRootRef: (el: HTMLElement | null) => void;
  readonly onPreviewImage: (image: LightboxImage) => void;
}) {
  const { t } = useI18n();
  const [expandedFileKey, setExpandedFileKey] = useState<string | undefined>(undefined);
  const images = item.images ?? [];
  const files = item.files ?? [];

  return (
    <div
      ref={setRootRef}
      className={`ev-msg-user${wrapClass ? ` ${wrapClass}` : ""}`}
      data-item-key={item.key}
    >
      {images.length > 0 && (
        <div className="ev-user-images">
          {images.map((img, idx) => {
            const src = `data:${img.mimeType};base64,${img.data}`;
            const alt = `image-${idx + 1}`;
            const imgKey = `${item.key}:${img.mimeType}:${img.data.slice(0, 24)}:${img.data.length}`;
            return (
              <button
                key={imgKey}
                type="button"
                className="ev-user-image-btn"
                aria-label={t("composer.attachment.preview", { name: alt })}
                onClick={() => onPreviewImage({ src, alt })}
              >
                <img className="ev-user-image-thumb" src={src} alt={alt} />
              </button>
            );
          })}
        </div>
      )}

      {files.length > 0 && (
        <div className="ev-user-files">
          {files.map((file) => {
            const label = file.path ?? file.name;
            const fileKey = `${item.key}:${label}:${file.size}`;
            const isOpen = expandedFileKey === fileKey;
            const hasContent = file.content !== undefined && file.content.length > 0;
            return (
              <div key={fileKey} className="ev-user-file-item">
                <button
                  type="button"
                  className="ev-user-file-chip"
                  disabled={!hasContent}
                  aria-expanded={hasContent ? isOpen : undefined}
                  title={label}
                  onClick={() => setExpandedFileKey(isOpen ? undefined : fileKey)}
                >
                  <DescriptionIcon width={13} height={13} />
                  <span className="ev-mono ev-truncate">{label}</span>
                  <span className="ev-attachment-size ev-num">{formatBytes(file.size)}</span>
                </button>
                {hasContent && isOpen && (
                  <pre className="ev-pre ev-user-file-pre">{file.content}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      {item.text && <Markdown text={item.text} />}
    </div>
  );
}

function renderDisplayItem(item: DisplayItem, ctx: ItemRenderContext): ReactNode {
  const {
    t,
    onOpenWorker,
    onPreviewImage,
    highlightKey,
    wrapClass,
    setRootRef,
    revealedEditKey,
    flashEditKey,
  } = ctx;

  switch (item.kind) {
    case "user":
      return (
        <UserMessageItem
          item={item}
          wrapClass={wrapClass}
          setRootRef={setRootRef}
          onPreviewImage={onPreviewImage}
        />
      );

    case "notice": {
      const label = noticeMetaLabel(item.meta);
      const { workerId, ticketId } = label;
      return (
        <div
          ref={setRootRef}
          className={`ev-notice-card${wrapClass ? ` ${wrapClass}` : ""}`}
          data-tone={label.tone}
          data-item-key={item.key}
        >
          <div className="ev-notice-head">
            <div className="ev-notice-meta-row">
              <span className="ev-dot" data-stage={label.stage} />
              <span className="ev-notice-title">{label.title}</span>
              {label.badge && (
                <span className="eevee-badge" data-tone={label.badge.tone}>
                  {label.badge.text}
                </span>
              )}
              {ticketId && <span className="ev-chip-id">{ticketId}</span>}
            </div>
            {workerId && onOpenWorker && (
              <Button hierarchy="tertiary" density="compact" onClick={() => onOpenWorker(workerId)}>
                {t("transcript.observeWorker", { workerId })}
              </Button>
            )}
          </div>
          <Markdown text={item.text} />
        </div>
      );
    }

    case "thinking": {
      const firstLine =
        item.text.replace(/\r/g, "").split("\n", 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
      return (
        <DisclosureLine
          ref={setRootRef}
          itemKey={item.key}
          wrapClass={wrapClass}
          open={item.streaming === true}
          summary={
            <>
              <span className={item.streaming ? "ev-shiny" : undefined}>
                {item.streaming ? t("transcript.thinking.live") : t("transcript.thinking.done")}
              </span>
              {!item.streaming && firstLine && (
                <span className="ev-truncate ev-proc-summary-sub">{firstLine}</span>
              )}
            </>
          }
        >
          <div className={`ev-thinking-body${item.streaming ? " streaming" : ""}`}>{item.text}</div>
        </DisclosureLine>
      );
    }

    case "bash":
      return (
        <DisclosureLine
          ref={setRootRef}
          itemKey={item.key}
          wrapClass={wrapClass}
          open={item.status === "run"}
          summary={
            <>
              <span className={`ev-truncate${item.status === "run" ? " ev-shimmer" : ""}`}>
                {item.status === "run" ? t("transcript.bash.running") : t("transcript.bash.done")}{" "}
                <span className="ev-mono ev-proc-summary-mono">{item.command}</span>
              </span>
              {item.status === "err" && <span className="ev-minus">{t("transcript.failed")}</span>}
            </>
          }
        >
          {item.output && (
            <div className="ev-proc-body">
              <pre className="ev-pre">{item.output}</pre>
            </div>
          )}
        </DisclosureLine>
      );

    case "edit":
      return (
        <EditDisclosure
          item={item}
          revealed={item.key === revealedEditKey}
          flashing={item.key === flashEditKey}
          wrapClass={wrapClass}
          setRootRef={setRootRef}
        />
      );

    case "dispatch": {
      const summaryText = item.actions
        .map((a) => `${a.verb}${a.target ? ` ${a.target}` : ""}`)
        .join(" · ");
      const hasErr = item.actions.some((a) => a.status === "err");
      return (
        <DisclosureLine
          ref={setRootRef}
          itemKey={item.key}
          wrapClass={wrapClass}
          summary={
            <>
              <span className={`ev-truncate${item.live ? " ev-shimmer" : ""}`}>{summaryText}</span>
              {hasErr && <span className="ev-minus">{t("transcript.failed")}</span>}
            </>
          }
        >
          <div className="ev-proc-body ev-proc-stack">
            {item.actions.map((act) => {
              const workerId = act.workerId;
              return (
                <div key={act.id} className="ev-dispatch-card">
                  <div className="ev-dispatch-head">
                    <span className="ev-dispatch-verb">{act.verb}</span>
                    {act.target && <span className="ev-chip-id">{act.target}</span>}
                    {workerId && onOpenWorker && (
                      <button
                        type="button"
                        className="ev-chip-id ev-dispatch-link"
                        onClick={() => onOpenWorker(workerId)}
                      >
                        {t("transcript.openWorker", { workerId })}
                      </button>
                    )}
                  </div>
                  {act.detail && <span className="ev-dispatch-detail">{act.detail}</span>}
                </div>
              );
            })}
          </div>
        </DisclosureLine>
      );
    }

    case "tools": {
      const label =
        item.steps.length === 1
          ? `${item.steps[0]?.name} · ${item.steps[0]?.label}`
          : t("transcript.tools.multi", {
              count: item.steps.length,
              names: item.steps
                .map((s) => s.name)
                .slice(0, 3)
                .join(", "),
            });
      const hasErr = item.steps.some((s) => s.status === "error");
      return (
        <DisclosureLine
          ref={setRootRef}
          itemKey={item.key}
          wrapClass={wrapClass}
          open={item.live || hasErr}
          summary={
            <>
              <span className={`ev-truncate${item.live ? " ev-shimmer" : ""}`}>{label}</span>
              {hasErr && <span className="ev-minus">{t("transcript.errorSuffix")}</span>}
            </>
          }
        >
          <div className="ev-proc-body ev-proc-stack">
            {item.steps.map((step) => (
              <DisclosureLine
                key={step.id}
                iconSize={14}
                open={step.status === "error"}
                summary={
                  <>
                    <span className="ev-mono ev-step-name">{step.name}</span>
                    <span className="ev-truncate ev-proc-summary-mono">{step.label}</span>
                  </>
                }
              >
                <div className="ev-proc-body ev-proc-step-stack">
                  {Object.keys(step.arguments).length > 0 && (
                    <pre className="ev-pre">{JSON.stringify(step.arguments, null, 2)}</pre>
                  )}
                  {(step.outputText ?? step.streamingOutput) && (
                    <pre className="ev-pre">{step.outputText ?? step.streamingOutput}</pre>
                  )}
                </div>
              </DisclosureLine>
            ))}
          </div>
        </DisclosureLine>
      );
    }

    case "compaction":
      return (
        <div ref={setRootRef} data-item-key={item.key}>
          <div className="ev-marker">{t("transcript.compaction.marker")}</div>
          {item.summary && (
            <Collapsible.Root>
              <Collapsible.Trigger className="ev-tab-link">
                {t("transcript.compaction.summary")}
              </Collapsible.Trigger>
              <Collapsible.Panel>
                <pre className="ev-pre ev-compaction-pre">{item.summary}</pre>
              </Collapsible.Panel>
            </Collapsible.Root>
          )}
        </div>
      );

    case "reset":
      return (
        <div ref={setRootRef} className="ev-marker" data-item-key={item.key}>
          {t("transcript.reset.marker")}
        </div>
      );

    case "worked":
      return (
        <WorkedGroupView
          item={item}
          highlightKey={highlightKey}
          registerNode={setRootRef}
          renderChild={(child, childRevealedEditKey, childFlashEditKey) => (
            <TranscriptItemView
              key={child.key}
              item={child}
              onOpenWorker={onOpenWorker}
              highlightKey={highlightKey}
              revealedEditKey={childRevealedEditKey}
              flashEditKey={childFlashEditKey}
            />
          )}
        />
      );

    case "assistant":
      return (
        <div
          ref={setRootRef}
          className={`ev-msg-assistant${wrapClass ? ` ${wrapClass}` : ""}`}
          data-item-key={item.key}
        >
          {item.text && <Markdown text={item.text} streaming={item.streaming === true} />}
          {item.error && (
            <div className="ev-error-banner">
              {t("transcript.responseError", { error: item.error })}
            </div>
          )}
        </div>
      );
  }
}

export function TranscriptItemView({
  item,
  onOpenWorker,
  highlightKey,
  registerItemNode,
  revealedEditKey,
  flashEditKey,
}: {
  readonly item: DisplayItem;
  readonly onOpenWorker?: (workerId: WorkerId) => void;
  readonly highlightKey?: string;
  readonly registerItemNode?: (key: string, el: HTMLElement | null) => void;
  readonly revealedEditKey?: string;
  readonly flashEditKey?: string;
}) {
  const { t } = useI18n();
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | undefined>(undefined);

  const setRootRef = useCallback(
    (el: HTMLElement | null) => {
      registerItemNode?.(item.key, el);
    },
    [registerItemNode, item.key],
  );

  return (
    <>
      {renderDisplayItem(item, {
        t,
        onOpenWorker,
        onPreviewImage: setLightboxImage,
        highlightKey,
        wrapClass: highlightKey === item.key ? "ev-find-current" : undefined,
        setRootRef,
        revealedEditKey,
        flashEditKey,
      })}
      <AttachmentLightbox image={lightboxImage} onClose={() => setLightboxImage(undefined)} />
    </>
  );
}
