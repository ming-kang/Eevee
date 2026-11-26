import { RefreshIcon, SendIcon, StopIcon } from "@earendil-works/elanor-icons-react";
import { Button, SegmentedControl, Stack, TextArea } from "@earendil-works/elanor-react";
import type { ConversationRef, WhenBusy } from "@eevee/protocol";
import { type KeyboardEvent, useState } from "react";

export type ComposerProps = {
  readonly activeRef: ConversationRef;
  readonly busy: boolean;
  readonly hasRunFailure: boolean;
  readonly disabled: boolean;
  readonly onSend: (text: string, whenBusy: WhenBusy) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
};

export function Composer({
  activeRef,
  busy,
  hasRunFailure,
  disabled,
  onSend,
  onInterrupt,
  onRetry,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [whenBusy, setWhenBusy] = useState<WhenBusy>("followUp");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;
    setSending(true);
    setError(undefined);
    try {
      await onSend(trimmed, whenBusy);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
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

  return (
    <div className="eevee-composer-wrap">
      <div className="eevee-composer">
        {error && <div className="eevee-error-banner">{error}</div>}
        <TextArea
          value={text}
          onValueChange={(value) => setText(value)}
          onKeyDown={handleKeyDown}
          rows={3}
          disabled={disabled}
          placeholder={
            activeRef === "router"
              ? "发给 Router（Enter 发送，Shift+Enter 换行）..."
              : `直接向 Worker ${activeRef} 发送引导或指令（Enter 发送）...`
          }
        />
        <div className="eevee-composer-row">
          <Stack direction="row" gap="xSmall" align="center">
            {busy && (
              <SegmentedControl.Root
                density="compact"
                value={[whenBusy]}
                onValueChange={(values) => {
                  const value = values[0];
                  if (value === "followUp" || value === "steer") setWhenBusy(value);
                }}
              >
                <SegmentedControl.Item value="followUp">排队 (followUp)</SegmentedControl.Item>
                <SegmentedControl.Item value="steer">立即插入 (steer)</SegmentedControl.Item>
              </SegmentedControl.Root>
            )}
          </Stack>
          <Stack direction="row" gap="xSmall" align="center">
            {hasRunFailure && !busy && (
              <Button
                hierarchy="secondary"
                density="compact"
                iconStart={<RefreshIcon width={16} height={16} />}
                onClick={() => void runAction(onRetry)}
              >
                重试
              </Button>
            )}
            {busy && (
              <Button
                hierarchy="secondary"
                semantic="negative"
                density="compact"
                iconStart={<StopIcon width={16} height={16} />}
                onClick={() => void runAction(onInterrupt)}
              >
                中断
              </Button>
            )}
            <Button
              hierarchy="primary"
              density="compact"
              iconStart={<SendIcon width={16} height={16} />}
              disabled={disabled || text.trim().length === 0}
              pending={sending}
              onClick={() => void submit()}
            >
              发送
            </Button>
          </Stack>
        </div>
      </div>
    </div>
  );
}
