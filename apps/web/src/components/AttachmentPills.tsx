import { CloseIcon, DescriptionIcon, ExpandContentIcon } from "@earendil-works/elanor-icons-react";
import type { DraftAttachment } from "../lib/attachments.ts";
import { formatBytes } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import { EvTooltip } from "./EvTooltip.tsx";

export function AttachmentPills({
  attachments,
  onPreview,
  onExpandToText,
  onRemove,
}: {
  readonly attachments: readonly DraftAttachment[];
  readonly onPreview?: (attachment: DraftAttachment) => void;
  readonly onExpandToText?: (id: string) => void;
  readonly onRemove?: (id: string) => void;
}) {
  const { t } = useI18n();
  if (attachments.length === 0) return null;

  return (
    <div className="ev-attachment-pills">
      {attachments.map((item) => (
        <div key={item.id} className="ev-attachment-pill">
          {item.previewUrl ? (
            <button
              type="button"
              className="ev-attachment-preview-btn"
              aria-label={t("composer.attachment.preview", { name: item.name })}
              onClick={() => onPreview?.(item)}
            >
              <img className="ev-attachment-thumb" src={item.previewUrl} alt={item.name} />
              <span className="ev-truncate ev-attachment-name">{item.name}</span>
              <span className="ev-attachment-size ev-num">{formatBytes(item.size)}</span>
            </button>
          ) : (
            <div className="ev-attachment-file-meta">
              <DescriptionIcon width={14} height={14} className="ev-attachment-icon" />
              <EvTooltip content={item.name} side="top">
                <span className="ev-truncate ev-attachment-name">{item.name}</span>
              </EvTooltip>
              <span className="ev-attachment-size ev-num">{formatBytes(item.size)}</span>
            </div>
          )}
          {item.pastedText !== undefined && onExpandToText && (
            <EvTooltip content={t("composer.attachment.expandToText")} side="top">
              <button
                type="button"
                className="ev-attachment-action"
                aria-label={t("composer.attachment.expandToText")}
                onClick={() => onExpandToText(item.id)}
              >
                <ExpandContentIcon width={13} height={13} />
              </button>
            </EvTooltip>
          )}
          {onRemove && (
            <button
              type="button"
              className="ev-attachment-remove"
              aria-label={t("composer.attachment.remove", { name: item.name })}
              onClick={() => onRemove(item.id)}
            >
              <CloseIcon width={13} height={13} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
