import type { ReactNode } from "react";
import { useI18n } from "../lib/i18n.ts";
import type { InboxPreview } from "../lib/transcript.ts";
import { Composer, type ComposerProps } from "./Composer.tsx";

export type ConversationDockProps = ComposerProps & {
  readonly inbox: readonly InboxPreview[];
  readonly topSlot?: ReactNode;
  readonly hidden?: boolean;
};

export function ConversationDock({
  inbox,
  topSlot,
  hidden = false,
  ...composerProps
}: ConversationDockProps) {
  const { t } = useI18n();
  return (
    <div className="ev-composer-stack" hidden={hidden || undefined}>
      {topSlot}

      {inbox.length > 0 && (
        <div className="ev-queued-dock">
          <span className="ev-queued-dock-title">{t("chat.queued", { count: inbox.length })}</span>
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

      <Composer {...composerProps} />
    </div>
  );
}
