import {
  AutoAwesomeIcon,
  CloseIcon,
  CloudIcon,
  ExtensionIcon,
  PaletteIcon,
  SmartToyIcon,
  TuneIcon,
} from "@earendil-works/elanor-icons-react";
import { Heading, IconButton, SideNavigation, Tabs } from "@earendil-works/elanor-react";
import type { ReactNode } from "react";
import { type LocaleKey, useI18n } from "../lib/i18n.ts";
import type { SettingsSection } from "../lib/router.ts";
import { SHORTCUT_PRIORITY, useShortcutLayer } from "../lib/shortcut-stack.ts";
import { EvTooltip } from "./EvTooltip.tsx";
import { ConfigTab } from "./settings/ConfigTab.tsx";
import { GeneralTab } from "./settings/GeneralTab.tsx";
import { McpTab } from "./settings/McpTab.tsx";
import { ModelsTab } from "./settings/ModelsTab.tsx";
import { ProvidersTab } from "./settings/ProvidersTab.tsx";
import { SkillsTab } from "./settings/SkillsTab.tsx";

type SectionDef = {
  readonly id: SettingsSection;
  readonly labelKey: LocaleKey;
  readonly icon: ReactNode;
};

const SECTION_GROUPS: readonly {
  readonly id: string;
  readonly labelKey: LocaleKey;
  readonly items: readonly SectionDef[];
}[] = [
  {
    id: "system",
    labelKey: "settings.group.system",
    items: [
      {
        id: "general",
        labelKey: "settings.tab.general",
        icon: <PaletteIcon width={16} height={16} />,
      },
      {
        id: "config",
        labelKey: "settings.tab.config",
        icon: <TuneIcon width={16} height={16} />,
      },
    ],
  },
  {
    id: "models",
    labelKey: "settings.group.models",
    items: [
      {
        id: "providers",
        labelKey: "settings.tab.providers",
        icon: <CloudIcon width={16} height={16} />,
      },
      {
        id: "models",
        labelKey: "settings.tab.models",
        icon: <SmartToyIcon width={16} height={16} />,
      },
    ],
  },
  {
    id: "extensions",
    labelKey: "settings.group.extensions",
    items: [
      {
        id: "mcp",
        labelKey: "settings.tab.mcp",
        icon: <ExtensionIcon width={16} height={16} />,
      },
      {
        id: "skills",
        labelKey: "settings.tab.skills",
        icon: <AutoAwesomeIcon width={16} height={16} />,
      },
    ],
  },
];

const SECTIONS: readonly SectionDef[] = SECTION_GROUPS.flatMap((group) => group.items);

function isSettingsSection(value: unknown): value is SettingsSection {
  return SECTIONS.some((item) => item.id === value);
}

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

  const activeSection = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];

  return (
    <div
      className="ev-control-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
    >
      <div className="ev-settings-shell">
        <aside className="ev-settings-nav-pane">
          <div className="ev-settings-nav-head">
            <Heading level={1} size={6} className="ev-page-title">
              {t("settings.title")}
            </Heading>
          </div>
          <SideNavigation.Root className="ev-settings-sidenav" aria-label={t("settings.groups")}>
            {SECTION_GROUPS.map((group) => (
              <SideNavigation.Group key={group.id} className="ev-settings-nav-group">
                <SideNavigation.GroupLabel className="ev-settings-nav-group-label">
                  {t(group.labelKey)}
                </SideNavigation.GroupLabel>
                <SideNavigation.List className="ev-settings-nav-list">
                  {group.items.map((item) => (
                    <SideNavigation.Item key={item.id}>
                      <SideNavigation.Link
                        href={`#settings-${item.id}`}
                        active={section === item.id}
                        iconStart={item.icon}
                        className="ev-settings-nav-link"
                        onClick={(event) => {
                          event.preventDefault();
                          onSelectSection(item.id);
                        }}
                      >
                        {t(item.labelKey)}
                      </SideNavigation.Link>
                    </SideNavigation.Item>
                  ))}
                </SideNavigation.List>
              </SideNavigation.Group>
            ))}
          </SideNavigation.Root>
        </aside>

        <div className="ev-settings-content">
          <header className="ev-page-header ev-settings-header">
            <span className="ev-page-title ev-settings-mobile-only">{t("settings.title")}</span>
            <span className="ev-header-divider ev-settings-mobile-only" aria-hidden="true" />
            <Tabs.Root
              className="ev-header-tabs-root ev-settings-mobile-only"
              value={section}
              onValueChange={(next) => {
                if (isSettingsSection(next)) onSelectSection(next);
              }}
            >
              <Tabs.List className="ev-header-tabs" aria-label={t("settings.groups")}>
                {SECTIONS.map((item) => (
                  <Tabs.Tab key={item.id} value={item.id} className="ev-header-tab">
                    {t(item.labelKey)}
                  </Tabs.Tab>
                ))}
                <Tabs.Indicator className="ev-header-tabs-indicator" />
              </Tabs.List>
            </Tabs.Root>
            {activeSection && (
              <span className="ev-settings-crumb ev-settings-desktop-only">
                {t(activeSection.labelKey)}
              </span>
            )}
            <div className="ev-page-header-actions">
              <EvTooltip content={t("settings.closeTitle")} side="bottom">
                <IconButton aria-label={t("common.close")} onClick={onClose}>
                  <CloseIcon width={18} height={18} />
                </IconButton>
              </EvTooltip>
            </div>
          </header>

          <div className="ev-page-scroll ev-settings-main">
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
      </div>
    </div>
  );
}
