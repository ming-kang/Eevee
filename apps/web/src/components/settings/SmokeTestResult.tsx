import type { SmokeTestModelResponse } from "@eevee/protocol";

function formatMs(value: number | undefined): string {
  if (value === undefined) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

export function SmokeTestResult({ result }: { readonly result: SmokeTestModelResponse }) {
  const usage = result.usage;
  return (
    <div className="ev-smoke-result" data-ok={result.ok}>
      <div className="ev-smoke-head">
        <span className="eevee-badge" data-tone={result.ok ? "positive" : "negative"}>
          {result.ok ? "连接成功" : "连接失败"}
        </span>
        <span className="ev-num">TTFT {formatMs(result.ttftMs)}</span>
        <span className="ev-num">总耗时 {formatMs(result.totalMs)}</span>
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
