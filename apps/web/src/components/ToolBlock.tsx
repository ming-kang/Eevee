import { ChevronRightIcon, ExpandMoreIcon } from "@earendil-works/elanor-icons-react";
import { Collapsible, CopyButton, Stack } from "@earendil-works/elanor-react";
import { useState } from "react";
import type { ToolCallBlock } from "../lib/transcript.ts";

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  for (const preferred of ["path", "command", "pattern", "query", "workerId", "ticketId", "name"]) {
    const val = args[preferred];
    if (typeof val === "string" && val.length > 0) {
      return val.length > 80 ? `${val.slice(0, 80)}…` : val;
    }
  }
  const serialized = JSON.stringify(args);
  return serialized.length > 80 ? `${serialized.slice(0, 80)}…` : serialized;
}

export function ToolBlock({ tool }: { readonly tool: ToolCallBlock }) {
  const [open, setOpen] = useState(tool.status === "running" || tool.status === "error");
  const summary = summarizeArgs(tool.arguments);
  const stateAttr =
    tool.status === "error"
      ? "error"
      : tool.status === "running" || tool.status === "pending"
        ? "running"
        : "done";

  const output = tool.outputText ?? tool.streamingOutput;

  return (
    <div className="eevee-tool-block" data-state={stateAttr}>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="eevee-tool-trigger">
          {open ? (
            <ExpandMoreIcon width={14} height={14} />
          ) : (
            <ChevronRightIcon width={14} height={14} />
          )}
          <span className="eevee-dot" style={{ marginTop: 0 }} data-status={stateAttr} />
          <strong>{tool.name}</strong>
          {summary && <span className="eevee-tool-arg">{summary}</span>}
          <span
            className="eevee-badge"
            data-tone={
              stateAttr === "error" ? "negative" : stateAttr === "running" ? "info" : "neutral"
            }
          >
            {tool.status}
          </span>
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <div className="eevee-tool-body">
            {Object.keys(tool.arguments).length > 0 && (
              <div>
                <Stack direction="row" gap="xSmall" align="center" style={{ marginBottom: 4 }}>
                  <span
                    style={{ fontSize: "0.75rem", color: "var(--semantic-color-text-secondary)" }}
                  >
                    Arguments
                  </span>
                  <CopyButton
                    value={JSON.stringify(tool.arguments, null, 2)}
                    aria-label="复制参数"
                  />
                </Stack>
                <pre className="eevee-pre">{JSON.stringify(tool.arguments, null, 2)}</pre>
              </div>
            )}
            {output !== undefined && output.length > 0 && (
              <div>
                <Stack direction="row" gap="xSmall" align="center" style={{ marginBottom: 4 }}>
                  <span
                    style={{ fontSize: "0.75rem", color: "var(--semantic-color-text-secondary)" }}
                  >
                    {tool.isError ? "Error Output" : "Output"}
                  </span>
                  <CopyButton value={output} aria-label="复制输出" />
                </Stack>
                <pre className="eevee-pre">{output}</pre>
              </div>
            )}
            {tool.diagnostics && tool.diagnostics.length > 0 && (
              <div style={{ fontSize: "0.8rem", color: "var(--semantic-color-text-secondary)" }}>
                {tool.diagnostics.map((diag) => (
                  <div key={`${diag.severity}:${diag.message}`}>
                    [{diag.severity}] {diag.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}
