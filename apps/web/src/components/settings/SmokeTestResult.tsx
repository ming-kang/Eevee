import { CheckIcon } from "@earendil-works/elanor-icons-react";
import type { SmokeTestModelRequest, SmokeTestModelResponse } from "@eevee/protocol";
import { formatMs } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import { EvTooltip } from "../EvTooltip.tsx";

export function SmokeTestResult({
  result,
  request,
}: {
  readonly result: SmokeTestModelResponse;
  readonly request?: SmokeTestModelRequest;
}) {
  const { t } = useI18n();
  const usage = result.usage;
  const requestedThinking =
    request?.thinkingLevel !== undefined && request.thinkingLevel !== "off"
      ? request.thinkingLevel
      : undefined;
  const showReasoning = result.sawReasoning || requestedThinking !== undefined;
  const showTools = result.sawToolCall || request?.testTools === true;

  return (
    <div className="ev-smoke-result" data-ok={result.ok}>
      <div className="ev-smoke-head">
        <span className="eevee-badge" data-tone={result.ok ? "positive" : "negative"}>
          {t(result.ok ? "smoke.connected" : "smoke.failed")}
        </span>
        <div className="ev-smoke-timings ev-num">
          {result.ttftMs !== undefined && <span>TTFT {formatMs(result.ttftMs)}</span>}
          <span>{t("smoke.totalTime", { duration: formatMs(result.totalMs) })}</span>
        </div>
        {usage && (
          <EvTooltip
            content={t("smoke.usageDetail", {
              input: usage.input,
              output: usage.output,
              total: usage.totalTokens,
            })}
            side="top"
          >
            <span className="ev-smoke-usage ev-mono ev-num">
              ↑{usage.input} ↓{usage.output}
            </span>
          </EvTooltip>
        )}
      </div>

      {(showReasoning || showTools) && (
        <div className="ev-smoke-caps">
          {showReasoning && (
            <span className="ev-smoke-cap" data-hit={result.sawReasoning}>
              <span className="ev-smoke-cap-mark" aria-hidden="true">
                {result.sawReasoning ? <CheckIcon width={11} height={11} /> : "—"}
              </span>
              <span>Reasoning{requestedThinking ? ` (${requestedThinking})` : ""}</span>
            </span>
          )}
          {showTools && (
            <span className="ev-smoke-cap" data-hit={result.sawToolCall}>
              <span className="ev-smoke-cap-mark" aria-hidden="true">
                {result.sawToolCall ? <CheckIcon width={11} height={11} /> : "—"}
              </span>
              <span>Tool Call</span>
            </span>
          )}
        </div>
      )}

      {result.replyPreview && <div className="ev-smoke-preview">{result.replyPreview}</div>}
      {result.error && <div className="ev-smoke-error">{result.error}</div>}
    </div>
  );
}
