import { ChevronLeftIcon } from "@earendil-works/elanor-icons-react";
import { Button, Heading, Stack, Tabs } from "@earendil-works/elanor-react";
import { useState } from "react";
import { ConfigTab } from "./settings/ConfigTab.tsx";
import { McpTab } from "./settings/McpTab.tsx";
import { ModelsTab } from "./settings/ModelsTab.tsx";
import { ProvidersTab } from "./settings/ProvidersTab.tsx";

type SettingsTab = "providers" | "models" | "mcp" | "config";

export function SettingsView({ onBack }: { readonly onBack: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("providers");

  return (
    <main className="eevee-main">
      <header className="eevee-topbar">
        <div className="eevee-topbar-left">
          <Button
            hierarchy="tertiary"
            density="compact"
            iconStart={<ChevronLeftIcon width={16} height={16} />}
            onClick={onBack}
          >
            返回工作台
          </Button>
          <Heading level={1} size={5}>
            Engine 设置
          </Heading>
        </div>
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            if (
              value === "providers" ||
              value === "models" ||
              value === "mcp" ||
              value === "config"
            ) {
              setTab(value);
            }
          }}
        >
          <Tabs.List>
            <Tabs.Tab value="providers">Providers & Auth</Tabs.Tab>
            <Tabs.Tab value="models">Models & 画像</Tabs.Tab>
            <Tabs.Tab value="mcp">MCP</Tabs.Tab>
            <Tabs.Tab value="config">全局配置</Tabs.Tab>
            <Tabs.Indicator />
          </Tabs.List>
        </Tabs.Root>
      </header>

      <div className="eevee-settings-page">
        <div className="eevee-settings-inner">
          <Stack direction="column" gap="medium">
            {tab === "providers" && <ProvidersTab />}
            {tab === "models" && <ModelsTab />}
            {tab === "mcp" && <McpTab />}
            {tab === "config" && <ConfigTab />}
          </Stack>
        </div>
      </div>
    </main>
  );
}
