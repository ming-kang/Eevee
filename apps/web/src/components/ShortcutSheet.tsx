import {
  Button,
  Heading,
  KeyboardKey,
  KeyboardShortcut,
  Modal,
} from "@earendil-works/elanor-react";
import { useI18n } from "../lib/i18n.ts";
import { shortcutGroups } from "../lib/shortcuts.ts";

export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const groups = shortcutGroups();

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Portal>
        <Modal.Backdrop />
        <Modal.Viewport>
          <Modal.Popup>
            <Modal.Title>{t("shortcuts.title")}</Modal.Title>
            <Modal.Body>
              <div className="ev-form-stack" style={{ gap: 18 }}>
                {groups.map((group) => (
                  <div key={group.group} className="ev-form-stack" style={{ gap: 6 }}>
                    <Heading
                      level={3}
                      size={6}
                      style={{
                        fontSize: "0.75rem",
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "var(--ev-fg-subtle)",
                      }}
                    >
                      {group.group}
                    </Heading>
                    {group.rows.map((row) => (
                      <div
                        key={`${group.group}:${row.desc}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 16,
                          padding: "4px 0",
                          fontSize: "0.9375rem",
                          width: "100%",
                        }}
                      >
                        <span>{row.desc}</span>
                        <KeyboardShortcut>
                          {row.keys.map((k, idx) => (
                            <span key={`${k}-${idx === 0 ? "first" : "rest"}`}>
                              {idx > 0 ? " " : ""}
                              <KeyboardKey>{k}</KeyboardKey>
                            </span>
                          ))}
                        </KeyboardShortcut>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </Modal.Body>
            <Modal.Actions>
              <Modal.Close render={<Button hierarchy="secondary">{t("common.close")}</Button>} />
            </Modal.Actions>
          </Modal.Popup>
        </Modal.Viewport>
      </Modal.Portal>
    </Modal.Root>
  );
}
