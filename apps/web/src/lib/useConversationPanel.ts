import type { ConversationRef, MessageAttachment, WhenBusy } from "@eevee/protocol";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "./api.ts";
import { useConversationStream } from "./hooks.ts";
import { SHORTCUT_PRIORITY, useShortcutLayer } from "./shortcut-stack.ts";
import { lastContextUsage, parseAgentDoc, parseInbox, parseLiveDoc } from "./transcript.ts";

export function useConversationPanel(
  projectId: string | undefined,
  ref: ConversationRef | undefined,
  options?: { readonly interruptEnabled?: boolean },
) {
  const conv = useConversationStream(projectId, ref);
  const live = useMemo(() => parseLiveDoc(conv.view), [conv.view]);
  const inbox = useMemo(() => parseInbox(conv.view), [conv.view]);
  const agent = useMemo(() => parseAgentDoc(conv.view), [conv.view]);
  const contextUsage = useMemo(() => lastContextUsage(conv.entries), [conv.entries]);

  const interruptEnabled = options?.interruptEnabled ?? true;
  const lastEscRef = useRef(0);

  useEffect(() => {
    void live.busy;
    void projectId;
    void ref;
    void interruptEnabled;
    lastEscRef.current = 0;
  }, [live.busy, projectId, ref, interruptEnabled]);

  const send = useCallback(
    async (text: string, whenBusy: WhenBusy, attachments?: readonly MessageAttachment[]) => {
      if (!projectId || !ref) return;
      await api.sendMessage(projectId, ref, {
        text,
        whenBusy,
        ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
      });
    },
    [projectId, ref],
  );

  const interrupt = useCallback(async () => {
    if (!projectId || !ref) return;
    await api.interrupt(projectId, ref);
  }, [projectId, ref]);

  const retry = useCallback(async () => {
    if (!projectId || !ref) return;
    await api.retry(projectId, ref);
  }, [projectId, ref]);

  useShortcutLayer({
    id: `conversation-interrupt:${projectId ?? "none"}:${ref ?? "none"}`,
    active: Boolean(projectId && ref && live.busy && interruptEnabled),
    priority: SHORTCUT_PRIORITY.PAGE,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      const now = Date.now();
      if (now - lastEscRef.current < 450) {
        lastEscRef.current = 0;
        event.preventDefault();
        void interrupt();
        return true;
      }
      lastEscRef.current = now;
      return false;
    },
  });

  return {
    ...conv,
    live,
    inbox,
    agent,
    contextUsage,
    send,
    interrupt,
    retry,
  };
}
