import { CloseIcon } from "@earendil-works/elanor-icons-react";
import { createPortal } from "react-dom";
import { useI18n } from "../lib/i18n.ts";
import { dismissToast, useToasts } from "../lib/toasts.ts";

export function ToastHost() {
  const { t } = useI18n();
  const items = useToasts();
  if (items.length === 0) return null;
  const host = (
    <div className="ev-toasts" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className="ev-toast" data-tone={item.tone}>
          <span className="ev-toast-msg">{item.message}</span>
          <button
            type="button"
            className="ev-toast-close"
            aria-label={t("common.close")}
            onClick={() => dismissToast(item.id)}
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      ))}
    </div>
  );
  return typeof document === "undefined" ? host : createPortal(host, document.body);
}
