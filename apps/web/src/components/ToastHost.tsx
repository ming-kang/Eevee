import { createPortal } from "react-dom";
import { useToasts } from "../lib/toasts.ts";

export function ToastHost() {
  const items = useToasts();
  if (items.length === 0) return null;
  const host = (
    <div className="ev-toasts" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className="ev-toast" data-tone={item.tone}>
          {item.message}
        </div>
      ))}
    </div>
  );
  return typeof document === "undefined" ? host : createPortal(host, document.body);
}
