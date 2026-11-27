import { Button } from "@earendil-works/elanor-react";
import type { ConversationRef, EntryRecordPayload, WorkerId } from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../lib/i18n.ts";
import {
  buildDisplayItems,
  findMatches,
  foldTurns,
  type LiveDocView,
  outlineEntries,
} from "../lib/transcript.ts";
import { ConversationOutline } from "./ConversationOutline.tsx";
import { FindBar } from "./FindBar.tsx";
import { TranscriptItemView } from "./TranscriptItemView.tsx";

export type TranscriptViewProps = {
  readonly activeRef: ConversationRef;
  readonly entries: readonly EntryRecordPayload[];
  readonly live: LiveDocView;
  readonly hasMoreOlder: boolean;
  readonly loadingOlder: boolean;
  readonly onLoadOlder: () => void;
  readonly onOpenWorker?: (workerId: WorkerId) => void;
  readonly findOpen?: boolean;
  readonly onCloseFind?: () => void;
};

export function TranscriptView({
  activeRef,
  entries,
  live,
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
  onOpenWorker,
  findOpen = false,
  onCloseFind,
}: TranscriptViewProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const itemNodesRef = useRef(new Map<string, HTMLElement>());
  const stickRef = useRef(true);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [activeOutline, setActiveOutline] = useState(0);

  const registerItemNode = useCallback((key: string, el: HTMLElement | null) => {
    if (el) itemNodesRef.current.set(key, el);
    else itemNodesRef.current.delete(key);
  }, []);

  const displayItems = useMemo(() => {
    const raw = buildDisplayItems(entries, live);
    return foldTurns(raw, live.busy);
  }, [entries, live]);

  const outline = useMemo(() => outlineEntries(displayItems), [displayItems]);
  const matches = useMemo(
    () => (findOpen ? findMatches(displayItems, query) : []),
    [displayItems, findOpen, query],
  );

  useEffect(() => {
    if (!findOpen) {
      setQuery("");
      setMatchIdx(0);
    }
  }, [findOpen]);

  useEffect(() => {
    void query;
    setMatchIdx(0);
  }, [query]);

  const activeMatchKey = matches[matchIdx]?.key;

  const jumpToKey = useCallback((key: string) => {
    const el = itemNodesRef.current.get(key);
    if (!el) return;
    stickRef.current = false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (activeMatchKey) jumpToKey(activeMatchKey);
  }, [activeMatchKey, jumpToKey]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    if (outline.length >= 3) {
      const line = el.scrollTop + 120;
      let current = 0;
      outline.forEach((entry, idx) => {
        const node = itemNodesRef.current.get(entry.key);
        if (node && node.offsetTop <= line) current = idx;
      });
      setActiveOutline(current);
    }
  };

  const scrollSignal = `${activeRef}:${displayItems.length}:${live.partialText.length}:${live.partialThinking.length}:${live.activeTools.length}`;
  useEffect(() => {
    void scrollSignal;
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollSignal]);

  return (
    <div className="ev-transcript-wrap">
      {findOpen && onCloseFind && (
        <FindBar
          query={query}
          onQueryChange={setQuery}
          index={matchIdx}
          total={matches.length}
          onNext={() => matches.length > 0 && setMatchIdx((prev) => (prev + 1) % matches.length)}
          onPrev={() =>
            matches.length > 0 &&
            setMatchIdx((prev) => (prev - 1 + matches.length) % matches.length)
          }
          onClose={onCloseFind}
        />
      )}

      <ConversationOutline entries={outline} activeIndex={activeOutline} onPick={jumpToKey} />

      <div ref={scrollRef} className="ev-transcript-scroll" onScroll={handleScroll}>
        <div className="ev-transcript-inner">
          {hasMoreOlder && (
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Button
                hierarchy="secondary"
                density="compact"
                pending={loadingOlder}
                onClick={onLoadOlder}
              >
                {t("transcript.loadOlder")}
              </Button>
            </div>
          )}

          {displayItems.map((item) => (
            <TranscriptItemView
              key={item.key}
              item={item}
              onOpenWorker={onOpenWorker}
              highlightKey={activeMatchKey}
              registerItemNode={registerItemNode}
            />
          ))}

          {live.busy &&
            !live.partialText &&
            !live.partialThinking &&
            live.partialTools.length === 0 && (
              <div className="ev-live-status">
                <span className="ev-dot" data-stage="working" />
                <span>
                  {live.compacting
                    ? t("transcript.compacting")
                    : live.retryError
                      ? t("transcript.retrying", { error: live.retryError })
                      : t("transcript.running")}
                </span>
              </div>
            )}

          {live.runFailure && !live.busy && (
            <div className="ev-error-banner">
              {t("transcript.runInterrupted", { reason: live.runFailure.reason })}
              {live.runFailure.detail ? `: ${live.runFailure.detail}` : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
