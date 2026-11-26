import { FolderIcon } from "@earendil-works/elanor-icons-react";
import { Heading } from "@earendil-works/elanor-react";
import type { BoardViewPayload, ProjectSummary, WhenBusy, WorkerId } from "@eevee/protocol";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { shortPath } from "../lib/format.ts";
import { useConversationStream } from "../lib/hooks.ts";
import { lastContextUsage, parseAgentDoc, parseInbox, parseLiveDoc } from "../lib/transcript.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import { Composer } from "./Composer.tsx";
import { ProjectHeader } from "./ProjectHeader.tsx";
import { QuestionCard, QuestionStrip } from "./QuestionDock.tsx";
import { TranscriptView } from "./TranscriptView.tsx";

export function ChatPage({
  project,
  board,
  findOpen,
  onOpenFind,
  onCloseFind,
  onSelectView,
  onEditProject,
  onOpenWorker,
}: {
  readonly project: ProjectSummary;
  readonly board: BoardViewPayload | undefined;
  readonly findOpen: boolean;
  readonly onOpenFind: () => void;
  readonly onCloseFind: () => void;
  readonly onSelectView: (view: "chat" | "memory" | "usage") => void;
  readonly onEditProject: () => void;
  readonly onOpenWorker: (workerId: WorkerId) => void;
}) {
  const conv = useConversationStream(project.id, "router");
  const live = useMemo(() => parseLiveDoc(conv.view), [conv.view]);
  const inbox = useMemo(() => parseInbox(conv.view), [conv.view]);
  const agent = useMemo(() => parseAgentDoc(conv.view), [conv.view]);
  const contextUsage = useMemo(() => lastContextUsage(conv.entries), [conv.entries]);

  const openQuestions = useMemo(
    () =>
      (board?.questions ?? []).filter(
        (q) => q.answeredAt === undefined && q.withdrawnAt === undefined,
      ),
    [board],
  );
  const [later, setLater] = useState(false);

  useEffect(() => {
    if (openQuestions.length === 0) setLater(false);
  }, [openQuestions.length]);

  // Esc Esc double-tap interrupts active run.
  useEffect(() => {
    if (!live.busy) return;
    let lastEsc = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const now = Date.now();
      if (now - lastEsc < 450) {
        lastEsc = 0;
        void api.interrupt(project.id, "router");
      } else {
        lastEsc = now;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live.busy, project.id]);

  const loadedEmpty =
    conv.view !== undefined &&
    conv.entries.every((e) => e.kind === "pi.system") &&
    !live.busy &&
    !live.runFailure;

  return (
    <section className={`ev-chat-shell${loadedEmpty ? " landing" : ""}`}>
      <ProjectHeader
        project={project}
        view="chat"
        onSelectView={onSelectView}
        onEditProject={onEditProject}
        onOpenFind={onOpenFind}
        actions={
          !conv.connected ? (
            <span className="eevee-badge" data-tone="warning">
              重连中…
            </span>
          ) : undefined
        }
      />

      {conv.error && (
        <div style={{ padding: "8px 20px 0" }}>
          <div className="ev-error-banner">对话流异常：{conv.error}</div>
        </div>
      )}

      {loadedEmpty ? (
        <div className="ev-landing-hero">
          <div className="ev-landing-logo">
            <BrandLogo size={24} />
          </div>
          <Heading level={2} size={4} style={{ margin: 0 }}>
            {project.title}
          </Heading>
          {project.workspaces.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: 6,
                marginTop: 4,
              }}
            >
              {project.workspaces.map((ws) => (
                <span key={ws} className="ev-ws-chip" title={ws}>
                  <FolderIcon
                    width={13}
                    height={13}
                    style={{ flexShrink: 0, color: "var(--ev-fg-subtle)" }}
                  />
                  <span className="ev-truncate">{shortPath(ws)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <TranscriptView
          activeRef="router"
          entries={conv.entries}
          live={live}
          hasMoreOlder={conv.hasMoreOlder}
          loadingOlder={conv.loadingOlder}
          onLoadOlder={() => void conv.loadOlder()}
          onOpenWorker={onOpenWorker}
          findOpen={findOpen}
          onCloseFind={onCloseFind}
        />
      )}

      <div className="ev-dock">
        <div className="ev-dock-inner">
          {openQuestions.length > 0 && !later ? (
            <QuestionCard
              projectId={project.id}
              questions={openQuestions}
              onLater={() => setLater(true)}
            />
          ) : (
            <div className="ev-composer-stack">
              {openQuestions.length > 0 && later && openQuestions[0] && (
                <QuestionStrip
                  projectId={project.id}
                  question={openQuestions[0]}
                  count={openQuestions.length}
                  onExpand={() => setLater(false)}
                />
              )}

              {inbox.length > 0 && (
                <div className="ev-queued-dock">
                  <span style={{ fontSize: 11.5, color: "var(--ev-fg-subtle)", fontWeight: 500 }}>
                    队列中（{inbox.length}）
                  </span>
                  {inbox.map((item) => (
                    <div
                      key={item.id}
                      style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
                    >
                      <span className="ev-chip-id">{item.mode}</span>
                      <span className="ev-truncate" style={{ flex: 1 }}>
                        {item.text}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <Composer
                draftKey={`router:${project.id}`}
                activeRef="router"
                busy={live.busy}
                hasRunFailure={live.runFailure !== undefined}
                contextUsage={contextUsage}
                modelLabel={agent.modelLabel}
                onSend={async (text: string, whenBusy: WhenBusy) => {
                  await api.sendMessage(project.id, "router", { text, whenBusy });
                }}
                onInterrupt={async () => {
                  await api.interrupt(project.id, "router");
                }}
                onRetry={async () => {
                  await api.retry(project.id, "router");
                }}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
