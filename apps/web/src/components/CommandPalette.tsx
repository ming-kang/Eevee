import { SearchIcon } from "@earendil-works/elanor-icons-react";
import { KeyboardKey, KeyboardShortcut, Modal } from "@earendil-works/elanor-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../lib/i18n.ts";
import type { VisualStage } from "../lib/transcript.ts";

export type PaletteItem = {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly meta?: string;
  readonly stage?: VisualStage;
  readonly keys?: readonly string[];
  readonly keywords?: string;
  readonly run: () => void;
};

export function CommandPalette({
  open,
  items,
  onClose,
}: {
  readonly open: boolean;
  readonly items: readonly PaletteItem[];
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const shouldScrollSelectedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.label} ${item.group} ${item.meta ?? ""} ${item.keywords ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [items, query]);

  useEffect(() => {
    if (selected >= filtered.length) setSelected(Math.max(0, filtered.length - 1));
  }, [filtered.length, selected]);

  useEffect(() => {
    if (!open || !shouldScrollSelectedRef.current) return;
    shouldScrollSelectedRef.current = false;
    rowRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [open, selected]);

  if (!open) return null;

  rowRefs.current.length = filtered.length;

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length > 0) {
        shouldScrollSelectedRef.current = true;
        setSelected((prev) => (prev + 1) % filtered.length);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) {
        shouldScrollSelectedRef.current = true;
        setSelected((prev) => (prev - 1 + filtered.length) % filtered.length);
      }
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(filtered[selected]);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport className="ev-palette-backdrop">
          <Modal.Popup
            className="ev-palette-dialog"
            aria-label={t("palette.title")}
            onKeyDown={onKeyDown}
          >
            <div className="ev-palette-input-row">
              <SearchIcon width={18} height={18} />
              <input
                ref={inputRef}
                className="ev-raw-input"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("palette.placeholder")}
                aria-label={t("palette.searchLabel")}
                autoComplete="off"
              />
            </div>
            <div className="ev-palette-list" role="listbox" aria-label={t("palette.resultsLabel")}>
              {filtered.length === 0 ? (
                <div className="ev-palette-empty">{t("palette.empty")}</div>
              ) : (
                filtered.map((item, idx) => {
                  const showGroup = idx === 0 || filtered[idx - 1]?.group !== item.group;
                  return (
                    <div key={item.id}>
                      {showGroup && <div className="ev-palette-group">{item.group}</div>}
                      <button
                        ref={(el) => {
                          rowRefs.current[idx] = el;
                        }}
                        type="button"
                        role="option"
                        aria-selected={idx === selected}
                        className="ev-palette-row"
                        onMouseEnter={() => setSelected(idx)}
                        onClick={() => choose(item)}
                      >
                        {item.stage && <span className="ev-dot" data-stage={item.stage} />}
                        <span className="ev-truncate ev-flex-1">{item.label}</span>
                        {item.meta && <span className="ev-mono ev-palette-meta">{item.meta}</span>}
                        {item.keys && (
                          <KeyboardShortcut>
                            {item.keys.map((k) => (
                              <KeyboardKey key={k}>{k}</KeyboardKey>
                            ))}
                          </KeyboardShortcut>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
