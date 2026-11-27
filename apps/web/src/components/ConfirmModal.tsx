import { Button, Modal, Text } from "@earendil-works/elanor-react";
import type { ReactNode } from "react";
import { useI18n } from "../lib/i18n.ts";

export type ConfirmModalProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly tone?: "danger" | "primary";
  readonly pending?: boolean;
  readonly error?: string;
  readonly onConfirm: () => void | Promise<void>;
};

export function ConfirmModal({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "primary",
  pending = false,
  error,
  onConfirm,
}: ConfirmModalProps) {
  const { t } = useI18n();
  const resolvedConfirm = confirmLabel ?? t("common.confirm");
  const resolvedCancel = cancelLabel ?? t("common.cancel");
  return (
    <Modal.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onOpenChange(false);
      }}
    >
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup className="ev-confirm-dialog">
            <Modal.Title>{title}</Modal.Title>
            {(description !== undefined || error !== undefined) && (
              <Modal.Body>
                <div className="ev-form-stack">
                  {error && <div className="ev-error-banner">{error}</div>}
                  {description !== undefined &&
                    (typeof description === "string" ? (
                      <Text style={{ margin: 0 }}>{description}</Text>
                    ) : (
                      description
                    ))}
                </div>
              </Modal.Body>
            )}
            <Modal.Actions>
              <Modal.Close
                render={
                  <Button type="button" hierarchy="secondary" disabled={pending}>
                    {resolvedCancel}
                  </Button>
                }
              />
              <Button
                type="button"
                hierarchy="primary"
                semantic={tone === "danger" ? "negative" : "neutral"}
                pending={pending}
                onClick={() => void onConfirm()}
              >
                {resolvedConfirm}
              </Button>
            </Modal.Actions>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
