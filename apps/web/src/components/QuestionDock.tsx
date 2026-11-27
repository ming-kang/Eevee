import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExpandLessIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, IconButton, Input } from "@earendil-works/elanor-react";
import type { QuestionRecordPayload } from "@eevee/protocol";
import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { showToast } from "../lib/toasts.ts";

export function QuestionCard({
  projectId,
  questions,
  onLater,
}: {
  readonly projectId: string;
  readonly questions: readonly QuestionRecordPayload[];
  readonly onLater: () => void;
}) {
  const [qIndex, setQIndex] = useState(0);
  const [subIndex, setSubIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [otherFlags, setOtherFlags] = useState<Record<string, boolean[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const current = questions[Math.min(qIndex, Math.max(0, questions.length - 1))];

  useEffect(() => {
    setSubIndex(0);
    setError(undefined);
    if (!current) return;
    setDrafts((prev) => {
      if (prev[current.id]) return prev;
      return {
        ...prev,
        [current.id]: current.items.map((it) => it.recommended ?? ""),
      };
    });
    setOtherFlags((prev) => {
      if (prev[current.id]) return prev;
      return {
        ...prev,
        [current.id]: current.items.map((it) => (it.options?.length ?? 0) === 0),
      };
    });
  }, [current]);

  if (!current) return null;

  const items = current.items;
  const activeItem = items[subIndex] ?? items[0];
  const currentDraft = drafts[current.id] ?? items.map(() => "");
  const currentOther = otherFlags[current.id] ?? items.map(() => false);
  const options = activeItem?.options ?? [];
  const complete = items.every((_, idx) => (currentDraft[idx] ?? "").trim().length > 0);

  const selectOption = (idx: number, option: string) => {
    setDrafts((prev) => {
      const next = [...(prev[current.id] ?? items.map(() => ""))];
      next[idx] = option;
      return { ...prev, [current.id]: next };
    });
    setOtherFlags((prev) => {
      const next = [...(prev[current.id] ?? items.map(() => false))];
      next[idx] = false;
      return { ...prev, [current.id]: next };
    });
  };

  const openOther = (idx: number) => {
    setOtherFlags((prev) => {
      const next = [...(prev[current.id] ?? items.map(() => false))];
      next[idx] = true;
      return { ...prev, [current.id]: next };
    });
    setDrafts((prev) => {
      const next = [...(prev[current.id] ?? items.map(() => ""))];
      next[idx] = "";
      return { ...prev, [current.id]: next };
    });
  };

  const updateOther = (idx: number, val: string) => {
    setDrafts((prev) => {
      const next = [...(prev[current.id] ?? items.map(() => ""))];
      next[idx] = val;
      return { ...prev, [current.id]: next };
    });
  };

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!complete || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await api.answerQuestion(projectId, current.id, {
        answers: currentDraft.map((a) => a.trim()),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea")) return;
    if (/^[1-9]$/.test(event.key) && options.length <= 9) {
      const opt = options[Number(event.key) - 1];
      if (!opt) return;
      event.preventDefault();
      selectOption(subIndex, opt);
      if (subIndex < items.length - 1) setSubIndex(subIndex + 1);
    }
  };

  return (
    <form className="ev-qcard" onSubmit={(e) => void handleSubmit(e)} onKeyDown={onKeyDown}>
      <div className="ev-qcard-head">
        <span className="ev-dot" data-stage="answer" />
        <span>Router 向你提问</span>
        <span className="ev-chip-id">{current.id}</span>
        {questions.length > 1 && (
          <span style={{ display: "inline-flex", gap: 4, marginLeft: 4 }}>
            {questions.map((q, idx) => (
              <button
                key={q.id}
                type="button"
                className="ev-tab-link"
                style={{ height: 22, padding: "0 6px", fontSize: 11.5 }}
                data-active={idx === qIndex}
                onClick={() => setQIndex(idx)}
              >
                {q.id}
              </button>
            ))}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {items.length > 1 && (
          <span className="ev-num" style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <IconButton
              aria-label="上一子问"
              disabled={subIndex === 0}
              onClick={() => setSubIndex((i) => Math.max(0, i - 1))}
            >
              <ChevronLeftIcon width={15} height={15} />
            </IconButton>
            <span>
              {subIndex + 1}/{items.length}
            </span>
            <IconButton
              aria-label="下一子问"
              disabled={subIndex >= items.length - 1}
              onClick={() => setSubIndex((i) => Math.min(items.length - 1, i + 1))}
            >
              <ChevronRightIcon width={15} height={15} />
            </IconButton>
          </span>
        )}
      </div>

      {activeItem && (
        <div className="ev-qcard-body">
          <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.45 }}>
            {items.length > 1 && (
              <span className="ev-num" style={{ color: "var(--ev-fg-subtle)", marginRight: 6 }}>
                {subIndex + 1}.
              </span>
            )}
            {activeItem.question}
          </div>

          {options.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {options.map((opt, oi) => {
                const selected = !currentOther[subIndex] && currentDraft[subIndex] === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    aria-pressed={selected}
                    className="ev-qopt"
                    onClick={() => selectOption(subIndex, opt)}
                  >
                    <span className="ev-qradio" />
                    <span>{opt}</span>
                    {opt === activeItem.recommended && (
                      <span className="eevee-badge" style={{ marginLeft: 4 }}>
                        推荐
                      </span>
                    )}
                    {options.length <= 9 && <span className="ev-qdigit">{oi + 1}</span>}
                  </button>
                );
              })}
            </div>
          )}

          {currentOther[subIndex] ? (
            <Input
              type="text"
              value={currentDraft[subIndex] ?? ""}
              onValueChange={(val) => updateOther(subIndex, val)}
              placeholder="输入你的答复…"
            />
          ) : (
            <button
              type="button"
              className="ev-qopt"
              style={{ color: "var(--ev-fg-muted)", paddingLeft: 31 }}
              onClick={() => openOther(subIndex)}
            >
              其他自定义回答…
            </button>
          )}
        </div>
      )}

      <div className="ev-qcard-foot">
        {error && <span style={{ fontSize: 12, color: "var(--ev-danger)" }}>{error}</span>}
        <span style={{ flex: 1 }} />
        <Button type="button" hierarchy="tertiary" density="compact" onClick={onLater}>
          稍后回答
        </Button>
        {items.length > 1 && subIndex < items.length - 1 && (
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            onClick={() => setSubIndex((i) => i + 1)}
          >
            下一项
          </Button>
        )}
        <Button
          type="submit"
          hierarchy="primary"
          density="compact"
          disabled={!complete}
          pending={submitting}
        >
          提交答复
        </Button>
      </div>
    </form>
  );
}

export function QuestionStrip({
  projectId,
  question,
  count,
  onExpand,
}: {
  readonly projectId: string;
  readonly question: QuestionRecordPayload;
  readonly count: number;
  readonly onExpand: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const first = question.items[0];
  const quickOptions =
    question.items.length === 1 && first?.options && first.options.length > 0
      ? first.options
      : undefined;

  const quickPick = async (opt: string) => {
    setBusy(true);
    try {
      await api.answerQuestion(projectId, question.id, { answers: [opt] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ev-qstrip">
      <span className="ev-dot" data-stage="answer" />
      <button
        type="button"
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          background: "transparent",
          color: "inherit",
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: 0,
        }}
        onClick={onExpand}
      >
        <span className="ev-truncate">{first?.question ?? "待回答的问题"}</span>
        {count > 1 && <span className="ev-count-badge">+{count - 1}</span>}
      </button>
      <IconButton aria-label="展开提问卡片" title="展开提问卡片" onClick={onExpand}>
        <ExpandLessIcon width={16} height={16} />
      </IconButton>
      {quickOptions && (
        <div style={{ display: "flex", gap: 6, width: "100%", flexWrap: "wrap", paddingBottom: 2 }}>
          {quickOptions.map((opt) => (
            <Button
              key={opt}
              type="button"
              hierarchy="secondary"
              density="compact"
              disabled={busy}
              onClick={() => void quickPick(opt)}
            >
              {opt}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
