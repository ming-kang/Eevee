import { ArrowDownwardIcon } from "@earendil-works/elanor-icons-react";
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
import { EvTooltip } from "./EvTooltip.tsx";
import { FindBar } from "./FindBar.tsx";
import { TranscriptItemView } from "./TranscriptItemView.tsx";

const STICK_THRESHOLD_PX = 90;
const SCROLL_FAB_THRESHOLD_PX = 180;
const FADE_EDGE_PX = 12;

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
  const innerRef = useRef<HTMLDivElement | null>(null);
  const itemNodesRef = useRef(new Map<string, HTMLElement>());
  const stickRef = useRef(true);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [activeOutline, setActiveOutline] = useState(0);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

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

  const jumpToHeading = useCallback((headingId: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(headingId)}"]`);
    if (!el) return;
    stickRef.current = false;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (activeMatchKey) jumpToKey(activeMatchKey);
  }, [activeMatchKey, jumpToKey]);

  const syncScrollIndicators = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFadeTop(el.scrollTop > FADE_EDGE_PX);
    setFadeBottom(distBottom > FADE_EDGE_PX);
    setShowScrollBottom(distBottom > SCROLL_FAB_THRESHOLD_PX);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distBottom < STICK_THRESHOLD_PX;
    syncScrollIndicators();
    if (outline.length >= 3) {
      const line = el.scrollTop + 120;
      let current = 0;
      outline.forEach((entry, idx) => {
        const node = itemNodesRef.current.get(entry.key);
        if (node && node.offsetTop <= line) current = idx;
      });
      setActiveOutline(current);
    }
  }, [outline, syncScrollIndicators]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setShowScrollBottom(false);
  }, []);

  useEffect(() => {
    void activeRef;
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      syncScrollIndicators();
    }
  }, [activeRef, syncScrollIndicators]);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    const innerEl = innerRef.current;
    if (!scrollEl || !innerEl) return;

    const keepAtBottom = () => {
      if (stickRef.current) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
      syncScrollIndicators();
    };

    const mo =
      typeof MutationObserver !== "undefined" ? new MutationObserver(keepAtBottom) : undefined;
    mo?.observe(innerEl, { childList: true, subtree: true, characterData: true });

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(keepAtBottom) : undefined;
    ro?.observe(innerEl);
    ro?.observe(scrollEl);

    keepAtBottom();

    return () => {
      mo?.disconnect();
      ro?.disconnect();
    };
  }, [syncScrollIndicators]);

  const scrollSignal = `${activeRef}:${displayItems.length}:${live.partialText.length}:${live.partialThinking.length}:${live.activeTools.length}`;
  useEffect(() => {
    void scrollSignal;
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    syncScrollIndicators();
  }, [scrollSignal, syncScrollIndicators]);

  return (
    <div
      className="ev-transcript-wrap"
      data-fade-top={fadeTop || undefined}
      data-fade-bottom={fadeBottom || undefined}
    >
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

      <ConversationOutline
        entries={outline}
        activeIndex={activeOutline}
        onPick={jumpToKey}
        onPickHeading={jumpToHeading}
      />

      <div ref={scrollRef} className="ev-transcript-scroll" onScroll={handleScroll}>
        <div ref={innerRef} className="ev-transcript-inner">
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

      {showScrollBottom && (
        <div className="ev-scroll-bottom-wrap">
          <EvTooltip
            content={
              live.busy ? t("transcript.scrollToBottomStreaming") : t("transcript.scrollToBottom")
            }
            side="left"
          >
            <button
              type="button"
              className="ev-scroll-bottom-btn"
              data-streaming={live.busy || undefined}
              aria-label={
                live.busy ? t("transcript.scrollToBottomStreaming") : t("transcript.scrollToBottom")
              }
              onClick={() => scrollToBottom("smooth")}
            >
              {live.busy && <span className="ev-dot" data-stage="working" />}
              <ArrowDownwardIcon width={16} height={16} />
            </button>
          </EvTooltip>
        </div>
      )}
    </div>
  );
}
