import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { formatDurationMs, shortPath } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import {
  activitySummary,
  closedWorkedItems,
  type DisplayItem,
  editSummary,
} from "../../lib/transcript.ts";
import { EvTooltip } from "../EvTooltip.tsx";

export function WorkedGroupView({
  item,
  highlightKey,
  registerNode,
  renderChild,
}: {
  readonly item: Extract<DisplayItem, { kind: "worked" }>;
  readonly highlightKey?: string;
  readonly registerNode?: (el: HTMLElement | null) => void;
  readonly renderChild: (
    child: DisplayItem,
    revealedEditKey?: string,
    flashEditKey?: string,
  ) => ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pathsOpen, setPathsOpen] = useState(false);
  const [revealedEditKey, setRevealedEditKey] = useState<string | undefined>(undefined);
  const [flashEditKey, setFlashEditKey] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (flashEditKey === undefined) return;
    const timer = window.setTimeout(() => {
      setFlashEditKey(undefined);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [flashEditKey]);

  const label =
    item.ms !== undefined
      ? t("transcript.worked.elapsed", { duration: formatDurationMs(item.ms) })
      : t("transcript.worked.done");
  const summaryText = activitySummary(item.activity);
  const edits = editSummary(item.items);
  const shown = open ? item.items : closedWorkedItems(item);

  const revealEdit = (key: string) => {
    setOpen(true);
    setRevealedEditKey(key);
    setFlashEditKey(key);
  };

  return (
    <div
      ref={registerNode}
      className={`ev-worked${highlightKey === item.key ? " ev-find-current" : ""}`}
      data-item-key={item.key}
    >
      <div className="ev-worked-head">
        <button
          type="button"
          className="ev-worked-toggle"
          aria-expanded={open}
          onClick={() =>
            setOpen((prev) => {
              if (prev) {
                setRevealedEditKey(undefined);
                setFlashEditKey(undefined);
              }
              return !prev;
            })
          }
        >
          <ChevronRightIcon width={15} height={15} className="ev-proc-chev" />
          <span className="ev-proc-label">{label}</span>
          {summaryText && <span className="ev-truncate ev-worked-sub">· {summaryText}</span>}
        </button>
        {!open && edits && (
          <EvTooltip
            content={t("transcript.worked.filesEditedTitle", { count: edits.files })}
            side="top"
          >
            <button
              type="button"
              className="ev-diffstat ev-num"
              aria-expanded={pathsOpen}
              onClick={() => setPathsOpen((prev) => !prev)}
            >
              {edits.added > 0 && <span className="ev-plus">+{edits.added}</span>}
              {edits.removed > 0 && <span className="ev-minus">−{edits.removed}</span>}
              <ChevronRightIcon
                width={13}
                height={13}
                className={`ev-worked-paths-chev${pathsOpen ? " open" : ""}`}
              />
            </button>
          </EvTooltip>
        )}
      </div>

      {!open && pathsOpen && edits && (
        <div className="ev-worked-paths">
          {edits.paths.map((p) => (
            <EvTooltip key={p.key} content={p.path} side="top">
              <button
                type="button"
                className="ev-tab-link ev-worked-path-btn"
                onClick={() => revealEdit(p.key)}
              >
                <span className="ev-mono ev-truncate ev-proc-summary-mono">
                  {shortPath(p.path)}
                </span>
                <span className="ev-mono ev-num ev-worked-path-counts">
                  {p.added > 0 && <span className="ev-plus">+{p.added}</span>}
                  {p.removed > 0 && <span className="ev-minus">−{p.removed}</span>}
                </span>
              </button>
            </EvTooltip>
          ))}
        </div>
      )}

      {shown.map((child) => renderChild(child, revealedEditKey, flashEditKey))}
    </div>
  );
}
