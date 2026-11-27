import { CheckIcon, ContentCopyIcon } from "@earendil-works/elanor-icons-react";
import { KeyValue, Popover } from "@earendil-works/elanor-react";
import { useCallback, useState } from "react";
import { formatCost, formatDurationMs, formatTokens } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import { copyToClipboard } from "../../lib/markdown-utils.ts";
import { showToast } from "../../lib/toasts.ts";
import type { AssistantMeta } from "../../lib/transcript.ts";
import { EvTooltip } from "../EvTooltip.tsx";
import { ProviderIcon } from "../ProviderIcon.tsx";

function computeCacheHitPct(meta: AssistantMeta): number | undefined {
  const read = meta.cacheRead ?? 0;
  const input = meta.input ?? 0;
  const write = meta.cacheWrite ?? 0;
  const denom = input + read + write;
  if (read <= 0 || denom <= 0) return undefined;
  return Math.round((read / denom) * 100);
}

export function AssistantFooter({
  markdown,
  meta,
}: {
  readonly markdown: string;
  readonly meta?: AssistantMeta;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(markdown);
    if (!ok) return;
    setCopied(true);
    showToast(t("transcript.copied"));
    window.setTimeout(() => setCopied(false), 1400);
  }, [markdown, t]);

  const modelLabel = meta?.model;
  const cachePct = meta ? computeCacheHitPct(meta) : undefined;
  const hasUsageTokens =
    meta !== undefined && (meta.input !== undefined || meta.output !== undefined);
  const hasDetailPopover =
    meta !== undefined &&
    (modelLabel !== undefined ||
      hasUsageTokens ||
      meta.durationMs !== undefined ||
      meta.costTotal !== undefined);

  return (
    <div className="ev-msg-footer">
      <EvTooltip
        content={copied ? t("transcript.copied") : t("transcript.copyMarkdown")}
        side="top"
      >
        <button
          type="button"
          className="ev-msg-action-btn"
          aria-label={t("transcript.copyMarkdown")}
          onClick={handleCopy}
        >
          {copied ? (
            <CheckIcon width={14} height={14} />
          ) : (
            <ContentCopyIcon width={14} height={14} />
          )}
        </button>
      </EvTooltip>

      {hasDetailPopover && meta && (
        <Popover.Root>
          <Popover.Trigger className="ev-msg-meta-trigger">
            {modelLabel && (
              <span className="ev-msg-meta-model ev-mono">
                <ProviderIcon provider={meta.provider} size={12} />
                <span>{modelLabel}</span>
              </span>
            )}
            {hasUsageTokens && (
              <span className="ev-msg-meta-item ev-mono ev-num">
                {meta.input !== undefined ? `↑${formatTokens(meta.input)}` : ""}
                {meta.input !== undefined && meta.output !== undefined ? " " : ""}
                {meta.output !== undefined ? `↓${formatTokens(meta.output)}` : ""}
              </span>
            )}
            {cachePct !== undefined && (
              <span className="ev-msg-meta-item ev-mono ev-num">Cache {cachePct}%</span>
            )}
            {meta.durationMs !== undefined && meta.durationMs >= 500 && (
              <span className="ev-msg-meta-item ev-mono ev-num">
                {formatDurationMs(meta.durationMs)}
              </span>
            )}
            {meta.costTotal !== undefined && meta.costTotal > 0 && (
              <span className="ev-msg-meta-item ev-mono ev-num">{formatCost(meta.costTotal)}</span>
            )}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="top" align="start" sideOffset={6} style={{ zIndex: 1300 }}>
              <Popover.Popup className="ev-meta-popover">
                <div className="ev-meta-popover-title">{t("transcript.meta.detailsTitle")}</div>
                <KeyValue.Grid className="ev-meta-kv">
                  {modelLabel && (
                    <>
                      <KeyValue.Key>{t("transcript.meta.model")}</KeyValue.Key>
                      <KeyValue.Value className="ev-mono">
                        {meta.provider ? `${meta.provider}/${modelLabel}` : modelLabel}
                      </KeyValue.Value>
                    </>
                  )}
                  {meta.input !== undefined && (
                    <>
                      <KeyValue.Key>{t("transcript.meta.input")}</KeyValue.Key>
                      <KeyValue.Value className="ev-mono ev-num">
                        {meta.input.toLocaleString()}
                      </KeyValue.Value>
                    </>
                  )}
                  {meta.output !== undefined && (
                    <>
                      <KeyValue.Key>{t("transcript.meta.output")}</KeyValue.Key>
                      <KeyValue.Value className="ev-mono ev-num">
                        {meta.output.toLocaleString()}
                      </KeyValue.Value>
                    </>
                  )}
                  {meta.cacheRead !== undefined && meta.cacheRead > 0 && (
                    <>
                      <KeyValue.Key>{t("transcript.meta.cacheRead")}</KeyValue.Key>
                      <KeyValue.Value className="ev-mono ev-num">
                        {meta.cacheRead.toLocaleString()}
                      </KeyValue.Value>
                    </>
                  )}
                  {meta.cacheWrite !== undefined && meta.cacheWrite > 0 && (
                    <>
                      <KeyValue.Key>{t("transcript.meta.cacheWrite")}</KeyValue.Key>
                      <KeyValue.Value className="ev-mono ev-num">
                        {meta.cacheWrite.toLocaleString()}
                      </KeyValue.Value>
                    </>
                  )}
                  {cachePct !== undefined && (
                    <>
                      <KeyValue.Key>{t("transcript.meta.cacheHit")}</KeyValue.Key>
                      <KeyValue.Value className="ev-mono ev-num">{cachePct}%</KeyValue.Value>
                    </>
                  )}
                  {meta.durationMs !== undefined && (
                    <>
                      <KeyValue.Key>{t("transcript.meta.duration")}</KeyValue.Key>
                      <KeyValue.Value className="ev-mono ev-num">
                        {formatDurationMs(meta.durationMs)}
                      </KeyValue.Value>
                    </>
                  )}
                  {meta.costTotal !== undefined && meta.costTotal > 0 && (
                    <>
                      <KeyValue.Key>{t("transcript.meta.cost")}</KeyValue.Key>
                      <KeyValue.Value className="ev-mono ev-num">
                        {formatCost(meta.costTotal)}
                      </KeyValue.Value>
                    </>
                  )}
                </KeyValue.Grid>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  );
}
