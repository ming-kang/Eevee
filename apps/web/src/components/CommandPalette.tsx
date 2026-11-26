import { SearchIcon } from "@earendil-works/elanor-icons-react";
import { KeyboardKey, KeyboardShortcut, Modal } from "@earendil-works/elanor-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
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
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  if (!open) return null;

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
      if (filtered.length > 0) setSelected((prev) => (prev + 1) % filtered.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) {
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
          <Modal.Popup className="ev-palette-dialog" aria-label="命令面板" onKeyDown={onKeyDown}>
            <div className="ev-palette-input-row">
              <SearchIcon width={17} height={17} />
              <input
                ref={inputRef}
                className="ev-raw-input"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索项目、Worker、页面或命令…"
                aria-label="搜索命令或跳转"
                autoComplete="off"
              />
            </div>
            <div className="ev-palette-list" role="listbox" aria-label="匹配结果">
              {filtered.length === 0 ? (
                <div
                  style={{
                    padding: "18px 12px",
                    textAlign: "center",
                    fontSize: 13,
                    color: "var(--ev-fg-subtle)",
                  }}
                >
                  无匹配项
                </div>
              ) : (
                filtered.map((item, idx) => {
                  const showGroup = idx === 0 || filtered[idx - 1]?.group !== item.group;
                  return (
                    <div key={item.id}>
                      {showGroup && (
                        <div
                          style={{
                            padding: "7px 10px 3px",
                            fontSize: 11.5,
                            fontWeight: 500,
                            color: "var(--ev-fg-subtle)",
                          }}
                        >
                          {item.group}
                        </div>
                      )}
                      <button
                        type="button"
                        role="option"
                        aria-selected={idx === selected}
                        className="ev-palette-row"
                        onMouseEnter={() => setSelected(idx)}
                        onClick={() => choose(item)}
                      >
                        {item.stage && <span className="ev-dot" data-stage={item.stage} />}
                        <span className="ev-truncate" style={{ flex: 1 }}>
                          {item.label}
                        </span>
                        {item.meta && (
                          <span
                            className="ev-mono"
                            style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)" }}
                          >
                            {item.meta}
                          </span>
                        )}
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
            <footer className="ev-palette-foot">
              <span>
                <kbd className="ev-mono">↑ ↓</kbd> 选择
              </span>
              <span>
                <kbd className="ev-mono">↵</kbd> 打开
              </span>
              <span style={{ marginLeft: "auto" }}>
                <kbd className="ev-mono">Esc</kbd> 关闭
              </span>
            </footer>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
