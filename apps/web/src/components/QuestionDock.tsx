import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExpandLessIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, IconButton, Input } from "@earendil-works/elanor-react";
import type { QuestionRecordPayload } from "@eevee/protocol";
import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
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
  const { t } = useI18n();
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
  const showHeader = questions.length > 1 || items.length > 1;

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
      {showHeader && (
        <div className="ev-qcard-head">
          <span className="ev-dot" data-stage="answer" />
          {questions.length > 1 ? (
            <span className="ev-qcard-tabs">
              {questions.map((q, idx) => (
                <button
                  key={q.id}
                  type="button"
                  className="ev-tab-link ev-qcard-tab"
                  data-active={idx === qIndex}
                  onClick={() => setQIndex(idx)}
                >
                  {q.id}
                </button>
              ))}
            </span>
          ) : (
            <span className="ev-chip-id">{current.id}</span>
          )}
          <span className="ev-flex-1" />
          {items.length > 1 && (
            <span className="ev-num ev-qcard-stepper">
              <IconButton
                aria-label={t("question.prevItem")}
                disabled={subIndex === 0}
                onClick={() => setSubIndex((i) => Math.max(0, i - 1))}
              >
                <ChevronLeftIcon width={15} height={15} />
              </IconButton>
              <span>
                {subIndex + 1}/{items.length}
              </span>
              <IconButton
                aria-label={t("question.nextItem")}
                disabled={subIndex >= items.length - 1}
                onClick={() => setSubIndex((i) => Math.min(items.length - 1, i + 1))}
              >
                <ChevronRightIcon width={15} height={15} />
              </IconButton>
            </span>
          )}
        </div>
      )}

      {activeItem && (
        <div className="ev-qcard-body">
          <div className="ev-qcard-question">
            {!showHeader && <span className="ev-dot" data-stage="answer" />}
            {items.length > 1 && <span className="ev-num ev-qcard-num">{subIndex + 1}.</span>}
            <span>{activeItem.question}</span>
          </div>

          {options.length > 0 && (
            <div className="ev-qopt-list">
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
                      <span className="eevee-badge">{t("question.recommended")}</span>
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
              placeholder={t("question.otherPlaceholder")}
            />
          ) : (
            <button
              type="button"
              className="ev-qopt ev-qopt-other"
              onClick={() => openOther(subIndex)}
            >
              {t("question.otherOption")}
            </button>
          )}
        </div>
      )}

      <div className="ev-qcard-foot">
        {error && <span className="ev-inline-error">{error}</span>}
        <span className="ev-flex-1" />
        <Button type="button" hierarchy="tertiary" density="compact" onClick={onLater}>
          {t("question.later")}
        </Button>
        {items.length > 1 && subIndex < items.length - 1 && (
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            onClick={() => setSubIndex((i) => i + 1)}
          >
            {t("question.next")}
          </Button>
        )}
        <Button
          type="submit"
          hierarchy="primary"
          density="compact"
          disabled={!complete}
          pending={submitting}
        >
          {t("question.submit")}
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
  const { t } = useI18n();
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
      <button type="button" className="ev-qstrip-btn" onClick={onExpand}>
        <span className="ev-truncate">{first?.question ?? t("question.pendingFallback")}</span>
        {count > 1 && <span className="ev-count-badge">+{count - 1}</span>}
      </button>
      <IconButton aria-label={t("question.expand")} title={t("question.expand")} onClick={onExpand}>
        <ExpandLessIcon width={16} height={16} />
      </IconButton>
      {quickOptions && (
        <div className="ev-qstrip-options">
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
