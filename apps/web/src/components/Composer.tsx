import { RefreshIcon, SendIcon, StopIcon } from "@earendil-works/elanor-icons-react";
import { Button, SegmentedControl, Stack } from "@earendil-works/elanor-react";
import type { ConversationRef, WhenBusy } from "@eevee/protocol";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { formatTokens } from "../lib/format.ts";
import type { ContextUsage } from "../lib/transcript.ts";

export type ComposerProps = {
  readonly draftKey: string;
  readonly activeRef: ConversationRef;
  readonly busy: boolean;
  readonly hasRunFailure: boolean;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly contextUsage?: ContextUsage;
  readonly modelLabel?: string;
  readonly onSend: (text: string, whenBusy: WhenBusy) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
};

export function Composer({
  draftKey,
  activeRef,
  busy,
  hasRunFailure,
  disabled = false,
  compact = false,
  contextUsage,
  modelLabel,
  onSend,
  onInterrupt,
  onRetry,
}: ComposerProps) {
  const [text, setText] = useState(() => {
    try {
      return window.localStorage.getItem(`eevee.draft.${draftKey}`) ?? "";
    } catch {
      return "";
    }
  });
  const [whenBusy, setWhenBusy] = useState<WhenBusy>("followUp");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    try {
      setText(window.localStorage.getItem(`eevee.draft.${draftKey}`) ?? "");
    } catch {
      setText("");
    }
    setError(undefined);
  }, [draftKey]);

  const updateText = (next: string) => {
    setText(next);
    try {
      if (next) window.localStorage.setItem(`eevee.draft.${draftKey}`, next);
      else window.localStorage.removeItem(`eevee.draft.${draftKey}`);
    } catch {
      // Ignore storage errors.
    }
  };

  useEffect(() => {
    void text;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, compact ? 130 : 200)}px`;
  }, [text, compact]);

  const submit = async (overrideMode?: WhenBusy) => {
    const trimmed = text.trim();
    if (!trimmed || submitting || disabled) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onSend(trimmed, overrideMode ?? whenBusy);
      updateText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (busy && (event.metaKey || event.ctrlKey)) {
        void submit(whenBusy === "steer" ? "followUp" : "steer");
      } else {
        void submit();
      }
    }
  };

  const runAction = async (fn: () => Promise<void>) => {
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const placeholder =
    activeRef === "router"
      ? busy
        ? "继续指示 Router…"
        : "发消息给 Router…"
      : `发消息给 ${activeRef}…`;

  return (
    <form className={`ev-composer-form${compact ? " compact" : ""}`} onSubmit={handleSubmit}>
      {error && <div className="ev-error-banner">{error}</div>}
      <textarea
        ref={textareaRef}
        className="ev-composer-textarea"
        rows={compact ? 1 : 2}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => updateText(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="ev-composer-bar">
        <Stack direction="row" gap="xSmall" align="center" style={{ flexWrap: "wrap" }}>
          {busy && (
            <SegmentedControl.Root
              density="compact"
              value={[whenBusy]}
              onValueChange={(values) => {
                const v = values[0];
                if (v === "followUp" || v === "steer") setWhenBusy(v);
              }}
            >
              <SegmentedControl.Item value="followUp">排队</SegmentedControl.Item>
              <SegmentedControl.Item value="steer">插入</SegmentedControl.Item>
            </SegmentedControl.Root>
          )}
          {!compact && modelLabel && (
            <span className="ev-mono" style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)" }}>
              {modelLabel}
            </span>
          )}
        </Stack>

        <Stack direction="row" gap="xSmall" align="center">
          {contextUsage && (
            <span
              className="ev-mono ev-num"
              style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)" }}
              title={`上下文 ${formatTokens(contextUsage.used)}（缓存命中 ${formatTokens(contextUsage.cached)}）`}
            >
              CTX {formatTokens(contextUsage.used)}
            </span>
          )}
          {hasRunFailure && !busy && (
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              iconStart={<RefreshIcon width={15} height={15} />}
              onClick={() => void runAction(onRetry)}
            >
              重试
            </Button>
          )}
          {busy && (
            <button
              type="button"
              className="ev-round-btn stop"
              aria-label="打断本轮执行"
              title="打断本轮执行（Esc Esc）"
              onClick={() => void runAction(onInterrupt)}
            >
              <StopIcon width={15} height={15} />
            </button>
          )}
          <button
            type="submit"
            className="ev-round-btn send"
            aria-label="发送"
            title="发送（Enter）"
            disabled={disabled || submitting || text.trim().length === 0}
          >
            <SendIcon width={15} height={15} />
          </button>
        </Stack>
      </div>
    </form>
  );
}
