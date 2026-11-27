import { CloseIcon } from "@earendil-works/elanor-icons-react";
import { IconButton, Modal } from "@earendil-works/elanor-react";
import { useI18n } from "../lib/i18n.ts";

export type LightboxImage = {
  readonly src: string;
  readonly alt: string;
  readonly caption?: string;
};

export function AttachmentLightbox({
  image,
  onClose,
}: {
  readonly image: LightboxImage | undefined;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();

  return (
    <Modal.Root open={image !== undefined} onOpenChange={(open) => !open && onClose()}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport className="ev-lightbox-viewport">
          <Modal.Popup className="ev-lightbox-panel" aria-label={t("composer.lightbox.title")}>
            {image && (
              <>
                <div className="ev-lightbox-head">
                  <span className="ev-truncate">{image.caption ?? image.alt}</span>
                  <IconButton aria-label={t("composer.lightbox.close")} onClick={onClose}>
                    <CloseIcon width={17} height={17} />
                  </IconButton>
                </div>
                <div className="ev-lightbox-body">
                  <img className="ev-lightbox-img" src={image.src} alt={image.alt} />
                </div>
              </>
            )}
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
