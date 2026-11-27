import { SegmentedControl } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectId, WorkerBoardItemPayload } from "@eevee/protocol";
import { useMemo, useState } from "react";
import { formatRelativeTime, shortPath, workerStatusLabel } from "../../lib/format.ts";
import { useConversationPanel } from "../../lib/useConversationPanel.ts";
import { ConversationDock } from "../ConversationDock.tsx";
import { TranscriptView } from "../TranscriptView.tsx";

export function WorkerPanel({
  projectId,
  worker,
  board,
}: {
  readonly projectId: ProjectId;
  readonly worker: WorkerBoardItemPayload | undefined;
  readonly board: BoardViewPayload | undefined;
}) {
  const [subTab, setSubTab] = useState<"chat" | "details">("chat");
  const workerId = worker?.id;
  const conv = useConversationPanel(projectId, workerId, {
    interruptEnabled: worker !== undefined && worker.status !== "closed" && subTab === "chat",
  });

  const tickets = useMemo(
    () => (board?.tickets ?? []).filter((t) => t.workerId === workerId),
    [board, workerId],
  );

  if (!worker) {
    return <div className="ev-rail-scroll ev-rail-empty-inline">未找到该 Worker。</div>;
  }

  const modelLabel =
    conv.agent.modelLabel ??
    (worker.model ? `${worker.model.provider}/${worker.model.modelId}` : undefined);

  return (
    <div className="ev-rail-section">
      <div className="ev-worker-subhead">
        <span className="ev-mono ev-truncate" title={worker.cwd}>
          {modelLabel ?? "默认模型"}
          {" · "}
          {shortPath(worker.cwd)}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {!conv.connected && (
            <span className="eevee-badge" data-tone="warning">
              重连中…
            </span>
          )}
          <SegmentedControl.Root
            density="compact"
            value={[subTab]}
            onValueChange={(vals) => {
              const v = vals[0];
              if (v === "chat" || v === "details") setSubTab(v);
            }}
          >
            <SegmentedControl.Item value="chat">对话</SegmentedControl.Item>
            <SegmentedControl.Item value="details">详情</SegmentedControl.Item>
          </SegmentedControl.Root>
        </div>
      </div>

      {conv.error && (
        <div style={{ padding: "8px 12px 0" }}>
          <div className="ev-error-banner">对话流异常：{conv.error}</div>
        </div>
      )}

      {subTab === "details" ? (
        <div className="ev-rail-scroll ev-worker-details">
          <div className="ev-worker-meta">
            <div>
              <strong>状态：</strong>
              {workerStatusLabel(worker.status)}
            </div>
            <div>
              <strong>工作目录：</strong>
              <span className="ev-mono">{worker.cwd}</span>
            </div>
            <div>
              <strong>创建时间：</strong>
              {formatRelativeTime(worker.createdAt)}
            </div>
          </div>

          <div className="ev-group-label ev-worker-group-label">
            <span>关联 Tickets ({tickets.length})</span>
          </div>
          {tickets.length === 0 ? (
            <span className="ev-rail-empty-inline">暂无 Ticket</span>
          ) : (
            tickets.map((t) => (
              <div key={t.id} className="ev-worker-ticket">
                <div className="ev-worker-ticket-head">
                  <span className="ev-chip-id">{t.id}</span>
                  <span className="ev-worker-ticket-title">{t.title}</span>
                  <span className="eevee-badge">{t.status}</span>
                </div>
                {t.note && <div className="ev-worker-ticket-note">{t.note}</div>}
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <TranscriptView
            activeRef={worker.id}
            entries={conv.entries}
            live={conv.live}
            hasMoreOlder={conv.hasMoreOlder}
            loadingOlder={conv.loadingOlder}
            onLoadOlder={() => void conv.loadOlder()}
            compact
          />

          <div className="ev-worker-composer-wrap">
            {worker.status === "closed" ? (
              <div className="ev-worker-closed-note">该 Worker 已关闭（只读查看）</div>
            ) : (
              <ConversationDock
                inbox={conv.inbox}
                draftKey={`worker:${projectId}:${worker.id}`}
                projectId={projectId}
                activeRef={worker.id}
                busy={conv.live.busy}
                hasRunFailure={conv.live.runFailure !== undefined}
                compact
                contextUsage={conv.contextUsage}
                modelLabel={modelLabel}
                onSend={conv.send}
                onInterrupt={conv.interrupt}
                onRetry={conv.retry}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
