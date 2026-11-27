import { TocIcon } from "@earendil-works/elanor-icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatClock } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import { SHORTCUT_PRIORITY, useShortcutLayer } from "../lib/shortcut-stack.ts";
import type { OutlineEntry } from "../lib/transcript.ts";
import { EvTooltip } from "./EvTooltip.tsx";

const HOVER_CLOSE_DELAY_MS = 220;

export function ConversationOutline({
  entries,
  activeIndex,
  onPick,
}: {
  readonly entries: readonly OutlineEntry[];
  readonly activeIndex: number;
  readonly onPick: (key: string) => void;
}) {
  const { t } = useI18n();
  const listId = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const lastPointerTypeRef = useRef<string>("mouse");

  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hoverOpen || pinned;

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  }, []);

  const closeAll = useCallback(() => {
    clearCloseTimer();
    setHoverOpen(false);
    setPinned(false);
  }, [clearCloseTimer]);

  const scheduleHoverClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined;
      setHoverOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  useShortcutLayer({
    id: `conversation-outline:${listId}`,
    active: open,
    priority: SHORTCUT_PRIORITY.MODAL,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      closeAll();
      return true;
    },
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        closeAll();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, closeAll]);

  useEffect(() => {
    if (!open) return;
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  if (entries.length < 3) return null;

  const height = `min(${Math.max(1, entries.length - 1) * 16}px, 42vh)`;

  return (
    <nav
      ref={rootRef}
      className="ev-outline-anchor"
      aria-label={t("transcript.outlineLabel")}
      onPointerDown={(event) => {
        lastPointerTypeRef.current = event.pointerType;
      }}
      onMouseEnter={() => {
        if (lastPointerTypeRef.current === "touch") return;
        clearCloseTimer();
        setHoverOpen(true);
      }}
      onMouseLeave={() => {
        if (!pinned) scheduleHoverClose();
      }}
    >
      <div className="ev-outline-rail">
        <EvTooltip content={t("transcript.outlineLabel")} side="left">
          <button
            type="button"
            className="ev-outline-toggle"
            aria-label={t("transcript.outlineLabel")}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            data-pinned={pinned}
            onClick={() => {
              clearCloseTimer();
              setPinned((prev) => {
                const next = !prev;
                if (!next) setHoverOpen(false);
                return next;
              });
            }}
          >
            <TocIcon width={16} height={16} />
          </button>
        </EvTooltip>

        <div className="ev-outline-nav" style={{ height }}>
          {entries.map((entry, idx) => {
            const top = `${(entries.length > 1 ? idx / (entries.length - 1) : 0.5) * 100}%`;
            return (
              <button
                key={entry.key}
                type="button"
                className="ev-outline-tick"
                style={{ top }}
                data-active={idx === activeIndex}
                aria-label={entry.text || t("transcript.outlineMessageFallback")}
                onClick={(event) => {
                  if (lastPointerTypeRef.current === "touch" || event.detail === 0 || !open) {
                    setPinned(true);
                    return;
                  }
                  closeAll();
                  onPick(entry.key);
                }}
              />
            );
          })}
        </div>
      </div>

      {open && (
        <div className="ev-outline-pop-wrap">
          <ul id={listId} className="ev-outline-pop">
            {entries.map((entry, idx) => (
              <li key={entry.key}>
                <button
                  ref={idx === activeIndex ? activeRowRef : undefined}
                  type="button"
                  className="ev-outline-row"
                  data-active={idx === activeIndex}
                  onClick={() => {
                    closeAll();
                    onPick(entry.key);
                  }}
                >
                  <div className="ev-outline-row-head">
                    <span className="ev-truncate ev-outline-row-title">
                      {entry.text || t("transcript.outlineMessageFallback")}
                    </span>
                    {entry.at && (
                      <span className="ev-num ev-outline-row-time">{formatClock(entry.at)}</span>
                    )}
                  </div>
                  {entry.reply && (
                    <span className="ev-truncate ev-outline-row-reply">{entry.reply}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
