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
          <Modal.Popup className="ev-shortcuts-dialog">
            <Modal.Title>{t("shortcuts.title")}</Modal.Title>
            <Modal.Body>
              <div className="ev-shortcuts-groups">
                {groups.map((group) => (
                  <div key={group.group} className="ev-shortcuts-group">
                    <Heading level={3} size={6} className="ev-shortcuts-heading">
                      {group.group}
                    </Heading>
                    {group.rows.map((row) => (
                      <div key={`${group.group}:${row.desc}`} className="ev-shortcuts-row">
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
