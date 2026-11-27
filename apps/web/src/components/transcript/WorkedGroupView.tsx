import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import { type ReactNode, useRef, useState } from "react";
import { formatDurationMs, shortPath } from "../../lib/format.ts";
import {
  activitySummary,
  closedWorkedItems,
  type DisplayItem,
  editSummary,
} from "../../lib/transcript.ts";

export function WorkedGroupView({
  item,
  highlightKey,
  renderChild,
}: {
  readonly item: Extract<DisplayItem, { kind: "worked" }>;
  readonly highlightKey?: string;
  readonly renderChild: (child: DisplayItem) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pathsOpen, setPathsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const label = item.ms !== undefined ? `耗时 ${formatDurationMs(item.ms)}` : "已完成执行";
  const summaryText = activitySummary(item.activity);
  const edits = editSummary(item.items);
  const shown = open ? item.items : closedWorkedItems(item);

  const revealEdit = (key: string) => {
    setOpen(true);
    window.requestAnimationFrame(() => {
      const target = rootRef.current?.querySelector<HTMLElement>(
        `[data-edit-key="${CSS.escape(key)}"]`,
      );
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("flash");
      window.setTimeout(() => target.classList.remove("flash"), 1200);
    });
  };

  return (
    <div
      ref={rootRef}
      className={`ev-worked${highlightKey === item.key ? " ev-find-current" : ""}`}
      data-item-key={item.key}
    >
      <div className="ev-worked-head">
        <button
          type="button"
          className="ev-worked-toggle"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <ChevronRightIcon width={15} height={15} className="ev-proc-chev" />
          <span className="ev-truncate">{label}</span>
          {summaryText && <span className="ev-truncate ev-worked-sub">· {summaryText}</span>}
        </button>
        {!open && edits && (
          <button
            type="button"
            className="ev-diffstat ev-num"
            aria-expanded={pathsOpen}
            title={`编辑了 ${edits.files} 个文件`}
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
        )}
      </div>

      {!open && pathsOpen && edits && (
        <div className="ev-worked-paths">
          {edits.paths.map((p) => (
            <button
              key={p.key}
              type="button"
              className="ev-tab-link ev-worked-path-btn"
              onClick={() => revealEdit(p.key)}
            >
              <span className="ev-mono ev-truncate ev-proc-summary-mono" title={p.path}>
                {shortPath(p.path)}
              </span>
              <span className="ev-mono ev-num ev-worked-path-counts">
                {p.added > 0 && <span className="ev-plus">+{p.added}</span>}
                {p.removed > 0 && <span className="ev-minus">−{p.removed}</span>}
              </span>
            </button>
          ))}
        </div>
      )}

      {shown.map(renderChild)}
    </div>
  );
}
