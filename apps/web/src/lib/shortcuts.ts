import { t } from "./i18n.ts";

export type ShortcutRow = { readonly keys: readonly string[]; readonly desc: string };
export type ShortcutGroup = { readonly group: string; readonly rows: readonly ShortcutRow[] };

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
}

export function modLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

export function shortcutGroups(): readonly ShortcutGroup[] {
  const mod = modLabel();
  return [
    {
      group: t("shortcuts.group.nav"),
      rows: [
        { keys: [mod, "K"], desc: t("shortcuts.palette") },
        { keys: [mod, ","], desc: t("shortcuts.settings") },
        { keys: [mod, "B"], desc: t("shortcuts.toggleSide") },
        { keys: [mod, "Alt", "B"], desc: t("shortcuts.toggleRail") },
        { keys: ["?"], desc: t("shortcuts.sheet") },
      ],
    },
    {
      group: t("shortcuts.group.chat"),
      rows: [
        { keys: [mod, "F"], desc: t("shortcuts.find") },
        { keys: ["Enter"], desc: t("shortcuts.sendOrNext") },
        { keys: ["Shift", "Enter"], desc: t("shortcuts.newlineOrPrev") },
        { keys: [mod, "Enter"], desc: t("shortcuts.altSend") },
        { keys: ["Esc", "Esc"], desc: t("shortcuts.interrupt") },
      ],
    },
    {
      group: t("shortcuts.group.panel"),
      rows: [
        { keys: ["1–9"], desc: t("shortcuts.questionDigit") },
        { keys: ["Esc"], desc: t("shortcuts.closeOverlay") },
        { keys: [mod, "S"], desc: t("shortcuts.saveMemory") },
      ],
    },
  ];
}
