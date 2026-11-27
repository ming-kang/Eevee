import { CloseIcon } from "@earendil-works/elanor-icons-react";
import { Heading, IconButton } from "@earendil-works/elanor-react";
import { type LocaleKey, useI18n } from "../lib/i18n.ts";
import type { SettingsSection } from "../lib/router.ts";
import { SHORTCUT_PRIORITY, useShortcutLayer } from "../lib/shortcut-stack.ts";
import { ConfigTab } from "./settings/ConfigTab.tsx";
import { GeneralTab } from "./settings/GeneralTab.tsx";
import { McpTab } from "./settings/McpTab.tsx";
import { ModelsTab } from "./settings/ModelsTab.tsx";
import { ProvidersTab } from "./settings/ProvidersTab.tsx";
import { SkillsTab } from "./settings/SkillsTab.tsx";

const SECTIONS: readonly { readonly id: SettingsSection; readonly labelKey: LocaleKey }[] = [
  { id: "general", labelKey: "settings.tab.general" },
  { id: "providers", labelKey: "settings.tab.providers" },
  { id: "models", labelKey: "settings.tab.models" },
  { id: "mcp", labelKey: "settings.tab.mcp" },
  { id: "skills", labelKey: "settings.tab.skills" },
  { id: "config", labelKey: "settings.tab.config" },
];

export function SettingsView({
  section,
  onSelectSection,
  onClose,
}: {
  readonly section: SettingsSection;
  readonly onSelectSection: (section: SettingsSection) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();

  useShortcutLayer({
    id: "settings-overlay",
    active: true,
    priority: SHORTCUT_PRIORITY.OVERLAY,
    blocksLower: true,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select")) return false;
      if (
        typeof document !== "undefined" &&
        document.querySelector('[role="dialog"]:not(.ev-control-overlay), [role="alertdialog"]')
      ) {
        return false;
      }
      event.preventDefault();
      onClose();
      return true;
    },
  });

  return (
    <div
      className="ev-control-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
    >
      <header className="ev-page-header ev-settings-header">
        <Heading level={1} size={6} className="ev-page-title">
          {t("settings.title")}
        </Heading>
        <span className="ev-header-divider" aria-hidden="true" />
        <nav className="ev-header-nav" aria-label={t("settings.groups")}>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="ev-tab-link"
              data-active={section === item.id}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => onSelectSection(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>
        <div className="ev-page-header-actions">
          <IconButton
            aria-label={t("common.close")}
            title={t("settings.closeTitle")}
            onClick={onClose}
          >
            <CloseIcon width={18} height={18} />
          </IconButton>
        </div>
      </header>

      <div className="ev-page-scroll">
        <div className="ev-page-wide">
          {section === "general" && <GeneralTab />}
          {section === "providers" && <ProvidersTab />}
          {section === "models" && <ModelsTab />}
          {section === "mcp" && <McpTab />}
          {section === "skills" && <SkillsTab />}
          {section === "config" && <ConfigTab />}
        </div>
      </div>
    </div>
  );
}
