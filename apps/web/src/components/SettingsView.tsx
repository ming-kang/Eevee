import { CloseIcon } from "@earendil-works/elanor-icons-react";
import { Heading, IconButton } from "@earendil-works/elanor-react";
import { useEffect } from "react";
import type { SettingsSection } from "../lib/router.ts";
import { ConfigTab } from "./settings/ConfigTab.tsx";
import { McpTab } from "./settings/McpTab.tsx";
import { ModelsTab } from "./settings/ModelsTab.tsx";
import { ProvidersTab } from "./settings/ProvidersTab.tsx";
import { SkillsTab } from "./settings/SkillsTab.tsx";

const SECTIONS: readonly { readonly id: SettingsSection; readonly label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "models", label: "模型" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "config", label: "配置" },
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
  useEffect(() => {
    const onEsc = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select")) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  return (
    <div className="ev-control-overlay" role="dialog" aria-modal="true" aria-label="Engine 设置">
      <header className="ev-page-header" style={{ paddingLeft: 20, paddingRight: 16 }}>
        <Heading level={1} size={6} className="ev-page-title">
          Engine 设置
        </Heading>
        <span className="ev-header-divider" aria-hidden="true" />
        <nav className="ev-header-nav" aria-label="设置分组">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="ev-tab-link"
              data-active={section === item.id}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => onSelectSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <span style={{ flex: 1 }} />
        <IconButton aria-label="关闭设置" title="关闭（Esc）" onClick={onClose}>
          <CloseIcon width={18} height={18} />
        </IconButton>
      </header>

      <div className="ev-page-scroll">
        <div className="ev-page-narrow" style={{ maxWidth: 880 }}>
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
