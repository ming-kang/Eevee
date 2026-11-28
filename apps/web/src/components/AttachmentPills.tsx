import { DescriptionIcon, ExpandContentIcon } from "@earendil-works/elanor-icons-react";
import { Chip, IconButton } from "@earendil-works/elanor-react";
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
        <Chip.Root key={item.id} variant="outline" className="ev-attachment-chip">
          {item.previewUrl ? (
            <button
              type="button"
              className="ev-attachment-preview-btn"
              aria-label={t("composer.attachment.preview", { name: item.name })}
              onClick={() => onPreview?.(item)}
            >
              <img className="ev-attachment-thumb" src={item.previewUrl} alt="" />
              <Chip.Label>{item.name}</Chip.Label>
            </button>
          ) : (
            <>
              <Chip.Icon>
                <DescriptionIcon />
              </Chip.Icon>
              <EvTooltip content={item.name} side="top">
                <Chip.Label>{item.name}</Chip.Label>
              </EvTooltip>
            </>
          )}
          <span className="ev-attachment-size ev-num">{formatBytes(item.size)}</span>
          {item.pastedText !== undefined && onExpandToText && (
            <EvTooltip content={t("composer.attachment.expandToText")} side="top">
              <IconButton
                className="ev-attachment-action"
                aria-label={t("composer.attachment.expandToText")}
                onClick={() => onExpandToText(item.id)}
              >
                <ExpandContentIcon />
              </IconButton>
            </EvTooltip>
          )}
          {onRemove && (
            <Chip.Remove
              aria-label={t("composer.attachment.remove", { name: item.name })}
              onClick={() => onRemove(item.id)}
            />
          )}
        </Chip.Root>
      ))}
    </div>
  );
}
