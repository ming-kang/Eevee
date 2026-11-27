import { SegmentedControl } from "@earendil-works/elanor-react";
import type {
  BoardViewPayload,
  ProjectId,
  WhenBusy,
  WorkerBoardItemPayload,
} from "@eevee/protocol";
import { useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import { formatRelativeTime, shortPath, workerStatusLabel } from "../../lib/format.ts";
import { useConversationStream } from "../../lib/hooks.ts";
import { parseAgentDoc, parseInbox, parseLiveDoc } from "../../lib/transcript.ts";
import { Composer } from "../Composer.tsx";
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
  const conv = useConversationStream(projectId, workerId);
  const live = useMemo(() => parseLiveDoc(conv.view), [conv.view]);
  const inbox = useMemo(() => parseInbox(conv.view), [conv.view]);
  const agent = useMemo(() => parseAgentDoc(conv.view), [conv.view]);

  const tickets = useMemo(
    () => (board?.tickets ?? []).filter((t) => t.workerId === workerId),
    [board, workerId],
  );

  if (!worker) {
    return <div className="ev-rail-scroll ev-rail-empty-inline">未找到该 Worker。</div>;
  }

  return (
    <div className="ev-rail-section">
      <div className="ev-worker-subhead">
        <span className="ev-mono ev-truncate" title={worker.cwd}>
          {agent.modelLabel ??
            (worker.model ? `${worker.model.provider}/${worker.model.modelId}` : "默认模型")}
          {" · "}
          {shortPath(worker.cwd)}
        </span>
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
            live={live}
            hasMoreOlder={conv.hasMoreOlder}
            loadingOlder={conv.loadingOlder}
            onLoadOlder={() => void conv.loadOlder()}
            compact
          />

          <div className="ev-worker-composer-wrap">
            {worker.status === "closed" ? (
              <div className="ev-worker-closed-note">该 Worker 已关闭（只读查看）</div>
            ) : (
              <div className="ev-composer-stack">
                {inbox.length > 0 && (
                  <div className="ev-queued-dock">
                    <span className="ev-worker-inbox-title">队列中（{inbox.length}）</span>
                    {inbox.map((item) => (
                      <div key={item.id} className="ev-truncate">
                        <span className="ev-chip-id ev-worker-inbox-chip">{item.mode}</span>
                        {item.text}
                      </div>
                    ))}
                  </div>
                )}
                <Composer
                  draftKey={`worker:${projectId}:${worker.id}`}
                  projectId={projectId}
                  activeRef={worker.id}
                  busy={live.busy}
                  hasRunFailure={live.runFailure !== undefined}
                  compact
                  onSend={async (text: string, whenBusy: WhenBusy) => {
                    await api.sendMessage(projectId, worker.id, { text, whenBusy });
                  }}
                  onInterrupt={async () => {
                    await api.interrupt(projectId, worker.id);
                  }}
                  onRetry={async () => {
                    await api.retry(projectId, worker.id);
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
