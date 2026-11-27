import type { SmokeTestModelResponse } from "@eevee/protocol";
import { formatMs } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";

export function SmokeTestResult({ result }: { readonly result: SmokeTestModelResponse }) {
  const { t } = useI18n();
  const usage = result.usage;
  return (
    <div className="ev-smoke-result" data-ok={result.ok}>
      <div className="ev-smoke-head">
        <span className="eevee-badge" data-tone={result.ok ? "positive" : "negative"}>
          {t(result.ok ? "smoke.connected" : "smoke.failed")}
        </span>
        <span className="ev-num">TTFT {formatMs(result.ttftMs)}</span>
        <span className="ev-num">
          {t("smoke.totalTime", { duration: formatMs(result.totalMs) })}
        </span>
      </div>
      <div className="ev-smoke-metrics">
        <span>
          reasoning <strong>{result.sawReasoning ? "yes" : "no"}</strong>
        </span>
        <span>
          tool_call <strong>{result.sawToolCall ? "yes" : "no"}</strong>
        </span>
        <span>
          usage{" "}
          <strong className="ev-num">
            {usage ? `${usage.input} in / ${usage.output} out / ${usage.totalTokens} total` : "—"}
          </strong>
        </span>
      </div>
      {result.replyPreview && <div className="ev-smoke-preview">{result.replyPreview}</div>}
      {result.error && <div className="ev-smoke-error">{result.error}</div>}
    </div>
  );
}
