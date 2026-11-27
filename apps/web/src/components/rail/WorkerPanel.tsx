import { SegmentedControl } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectId, WorkerBoardItemPayload } from "@eevee/protocol";
import { useMemo, useState } from "react";
import { formatRelativeTime, shortPath, workerStatusLabel } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
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
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<"chat" | "details">("chat");
  const workerId = worker?.id;
  const conv = useConversationPanel(projectId, workerId, {
    interruptEnabled: worker !== undefined && worker.status !== "closed" && subTab === "chat",
  });

  const tickets = useMemo(
    () => (board?.tickets ?? []).filter((item) => item.workerId === workerId),
    [board, workerId],
  );

  if (!worker) {
    return <div className="ev-rail-scroll ev-rail-empty-inline">{t("rail.workerNotFound")}</div>;
  }

  const modelLabel =
    conv.agent.modelLabel ??
    (worker.model ? `${worker.model.provider}/${worker.model.modelId}` : undefined);

  return (
    <div className="ev-rail-section">
      <div className="ev-worker-subhead">
        <span className="ev-mono ev-truncate" title={worker.cwd}>
          {modelLabel ?? t("rail.defaultModel")}
          {" · "}
          {shortPath(worker.cwd)}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {!conv.connected && (
            <span className="eevee-badge" data-tone="warning">
              {t("common.reconnecting")}
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
            <SegmentedControl.Item value="chat">{t("rail.workerTab.chat")}</SegmentedControl.Item>
            <SegmentedControl.Item value="details">
              {t("rail.workerTab.details")}
            </SegmentedControl.Item>
          </SegmentedControl.Root>
        </div>
      </div>

      {conv.error && (
        <div style={{ padding: "8px 12px 0" }}>
          <div className="ev-error-banner">{t("chat.streamError", { error: conv.error })}</div>
        </div>
      )}

      {subTab === "details" ? (
        <div className="ev-rail-scroll ev-worker-details">
          <div className="ev-worker-meta">
            <div>
              <strong>{t("rail.worker.status")}</strong>
              {workerStatusLabel(worker.status)}
            </div>
            <div>
              <strong>{t("rail.worker.cwd")}</strong>
              <span className="ev-mono">{worker.cwd}</span>
            </div>
            <div>
              <strong>{t("rail.worker.createdAt")}</strong>
              {formatRelativeTime(worker.createdAt)}
            </div>
          </div>

          <div className="ev-group-label ev-worker-group-label">
            <span>{t("rail.worker.tickets", { count: tickets.length })}</span>
          </div>
          {tickets.length === 0 ? (
            <span className="ev-rail-empty-inline">{t("rail.worker.noTickets")}</span>
          ) : (
            tickets.map((item) => (
              <div key={item.id} className="ev-worker-ticket">
                <div className="ev-worker-ticket-head">
                  <span className="ev-chip-id">{item.id}</span>
                  <span className="ev-worker-ticket-title">{item.title}</span>
                  <span className="eevee-badge">{item.status}</span>
                </div>
                {item.note && <div className="ev-worker-ticket-note">{item.note}</div>}
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
              <div className="ev-worker-closed-note">{t("rail.worker.closedReadonly")}</div>
            ) : (
              <ConversationDock
                inbox={conv.inbox}
                board={board}
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
