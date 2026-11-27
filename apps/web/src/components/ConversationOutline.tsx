import { useState } from "react";
import { formatClock } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import type { OutlineEntry } from "../lib/transcript.ts";

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
  const [open, setOpen] = useState(false);

  if (entries.length < 3) return null;

  const height = `min(${Math.max(1, entries.length - 1) * 16}px, 42vh)`;

  return (
    <div className="ev-outline-anchor">
      <nav
        className="ev-outline-nav"
        style={{ height }}
        aria-label={t("transcript.outlineLabel")}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
            setOpen(false);
          }
        }}
      >
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
              onClick={() => {
                setOpen(false);
                onPick(entry.key);
              }}
            />
          );
        })}

        {open && (
          <ul className="ev-outline-pop" style={{ listStyle: "none", margin: 0 }}>
            {entries.map((entry, idx) => (
              <li key={entry.key}>
                <button
                  type="button"
                  className="ev-outline-row"
                  data-active={idx === activeIndex}
                  onClick={() => {
                    setOpen(false);
                    onPick(entry.key);
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                    <span className="ev-truncate" style={{ flex: 1, fontWeight: 500 }}>
                      {entry.text || t("transcript.outlineMessageFallback")}
                    </span>
                    {entry.at && (
                      <span
                        className="ev-num"
                        style={{ fontSize: 11, color: "var(--ev-fg-subtle)", flexShrink: 0 }}
                      >
                        {formatClock(entry.at)}
                      </span>
                    )}
                  </div>
                  {entry.reply && (
                    <span
                      className="ev-truncate"
                      style={{ fontSize: 12, color: "var(--ev-fg-subtle)" }}
                    >
                      {entry.reply}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  );
}
