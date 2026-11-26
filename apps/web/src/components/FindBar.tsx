import {
  CloseIcon,
  ExpandLessIcon,
  ExpandMoreIcon,
  SearchIcon,
} from "@earendil-works/elanor-icons-react";
import { IconButton } from "@earendil-works/elanor-react";
import { type KeyboardEvent, useEffect, useRef } from "react";

export function FindBar({
  query,
  onQueryChange,
  index,
  total,
  onNext,
  onPrev,
  onClose,
}: {
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly index: number;
  readonly total: number;
  readonly onNext: () => void;
  readonly onPrev: () => void;
  readonly onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) onPrev();
      else onNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="ev-find-anchor">
      <search className="ev-find-bar">
        <SearchIcon width={15} height={15} style={{ color: "var(--ev-fg-subtle)" }} />
        <input
          ref={inputRef}
          className="ev-raw-input"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="在对话中查找…"
          aria-label="在对话中查找"
        />
        <span
          className="ev-num"
          style={{
            minWidth: 46,
            textAlign: "center",
            fontSize: 12,
            color: "var(--ev-fg-subtle)",
          }}
          aria-live="polite"
        >
          {query.trim() === "" ? "" : total === 0 ? "0 / 0" : `${index + 1} / ${total}`}
        </span>
        <IconButton aria-label="上一个匹配" disabled={total === 0} onClick={onPrev}>
          <ExpandLessIcon width={16} height={16} />
        </IconButton>
        <IconButton aria-label="下一个匹配" disabled={total === 0} onClick={onNext}>
          <ExpandMoreIcon width={16} height={16} />
        </IconButton>
        <IconButton aria-label="关闭查找" onClick={onClose}>
          <CloseIcon width={15} height={15} />
        </IconButton>
      </search>
    </div>
  );
}
