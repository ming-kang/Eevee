import { AddIcon, CodeIcon, RefreshIcon } from "@earendil-works/elanor-icons-react";
import { Button, Heading } from "@earendil-works/elanor-react";
import type { McpServerSnapshotPayload } from "@eevee/protocol";
import { useState } from "react";
import { useI18n } from "../../lib/i18n.ts";
import { showToast } from "../../lib/toasts.ts";
import {
  createBlankForm,
  formFromConfig,
  type ServerFormState,
  validateServerName,
} from "./mcp/codec.ts";
import { McpJsonPanel } from "./mcp/McpJsonPanel.tsx";
import { McpServerForm } from "./mcp/McpServerForm.tsx";
import { McpServerRow } from "./mcp/McpServerRow.tsx";
import {
  buildPatchedServerConfig,
  buildScopedServerPayload,
  resolveToolExposureUpdate,
} from "./mcp/scope-helpers.ts";
import { useMcpScope } from "./mcp/useMcpScope.ts";
import { buildRoleTogglePatch } from "./mcp-helpers.ts";
import { useMcpOAuth } from "./useMcpOAuth.ts";

export function McpTab({
  projectId,
  compact = false,
}: {
  readonly projectId?: string;
  readonly compact?: boolean;
}) {
  return (
    <McpTabContent
      key={projectId === undefined ? "global" : `project:${projectId}`}
      projectId={projectId}
      compact={compact}
    />
  );
}

function McpTabContent({
  projectId,
  compact,
}: {
  readonly projectId?: string;
  readonly compact: boolean;
}) {
  const { t } = useI18n();
  const isProject = projectId !== undefined;
  const scope = useMcpScope(projectId);
  const {
    oauthSession,
    oauthMutatingServers,
    startOAuth,
    submitOAuthRedirect,
    cancelOAuth,
    logoutOAuth,
    setOAuthRedirectInput,
    dismissOAuth,
  } = useMcpOAuth({
    projectId,
    onRefresh: scope.reload,
    onError: scope.setError,
  });

  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectingServer, setReconnectingServer] = useState<string | undefined>(undefined);
  const [mutatingServers, setMutatingServers] = useState<Record<string, boolean>>({});
  const [formState, setFormState] = useState<ServerFormState | undefined>(undefined);
  const [jsonPanelOpen, setJsonPanelOpen] = useState(false);

  const withServerMutation = async (serverName: string, fn: () => Promise<void>) => {
    setMutatingServers((prev) => ({ ...prev, [serverName]: true }));
    scope.setError(undefined);
    try {
      await fn();
    } catch (err) {
      scope.setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutatingServers((prev) => {
        const copy = { ...prev };
        delete copy[serverName];
        return copy;
      });
    }
  };

  const upsertConfig = (serverName: string, config: Record<string, unknown>) =>
    withServerMutation(serverName, () => scope.upsertServer(serverName, config));

  const patchServer = (srv: McpServerSnapshotPayload, patch: Record<string, unknown>) => {
    void upsertConfig(
      srv.name,
      buildPatchedServerConfig({
        isProject,
        server: srv,
        globalServers: scope.globalServers,
        projectServers: scope.projectServers,
        effectiveServers: scope.effectiveServers,
        patch,
      }),
    );
  };

  const removeOrRevert = (srv: McpServerSnapshotPayload) =>
    withServerMutation(srv.name, async () => {
      await scope.deleteServer(srv.name);
      dismissOAuth(srv.name);
      if (formState?.originalName === srv.name) setFormState(undefined);
      showToast(
        isProject && srv.scope === "override"
          ? t("mcp.toast.reverted", { name: srv.name })
          : t("mcp.toast.deleted", { name: srv.name }),
      );
    });

  const handleToolExposureChange = async (
    srv: McpServerSnapshotPayload,
    toolName: string,
    nextValue: string,
  ) => {
    const result = resolveToolExposureUpdate({
      isProject,
      server: srv,
      globalServers: scope.globalServers,
      projectServers: scope.projectServers,
      toolName,
      nextValue,
    });
    if (result.action === "delete") await removeOrRevert(srv);
    else if (result.action === "upsert") await upsertConfig(srv.name, result.config);
  };

  const handleReconnect = async (server?: string) => {
    if (server) setReconnectingServer(server);
    else setReconnecting(true);
    scope.setError(undefined);
    try {
      await scope.reconnect(server);
    } catch (err) {
      scope.setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReconnecting(false);
      setReconnectingServer(undefined);
    }
  };

  const handleFormSubmit = async (form: ServerFormState) => {
    const serverName = validateServerName(form.name);
    await scope.upsertServer(
      serverName,
      buildScopedServerPayload({
        isProject,
        serverName,
        form,
        globalServers: scope.globalServers,
        projectServers: scope.projectServers,
        effectiveServers: scope.effectiveServers,
      }),
    );
    setFormState(undefined);
    showToast(
      form.mode === "create"
        ? t("mcp.toast.added", { name: serverName })
        : t("mcp.toast.updated", { name: serverName }),
    );
  };

  const handleImportJson = async (servers: Record<string, Record<string, unknown>>) => {
    await scope.putConfig(servers);
    setJsonPanelOpen(false);
    showToast(t(isProject ? "mcp.toast.importedProject" : "mcp.toast.importedGlobal"));
  };

  const projectConfigCount = Object.keys(scope.projectServers).length;

  return (
    <div className="ev-settings-section">
      <div className="ev-settings-head">
        <div className="ev-skill-head-title">
          <Heading level={compact ? 3 : 2} size={compact ? 6 : 5}>
            MCP
            <span className="ev-num ev-heading-count">{scope.statuses.length}</span>
          </Heading>
          {isProject && projectConfigCount > 0 && (
            <span className="eevee-badge ev-num" data-tone="warning">
              {t("mcp.projectConfigCount", { count: projectConfigCount })}
            </span>
          )}
        </div>
        <div className="ev-inline-actions">
          <Button
            type="button"
            hierarchy="primary"
            density="compact"
            iconStart={<AddIcon width={15} height={15} />}
            onClick={() => setFormState(createBlankForm())}
          >
            {t("mcp.addServer")}
          </Button>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<CodeIcon width={15} height={15} />}
            onClick={() => setJsonPanelOpen((prev) => !prev)}
          >
            {t("mcp.jsonImportExport")}
          </Button>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<RefreshIcon width={15} height={15} />}
            pending={reconnecting || scope.loading}
            onClick={() => void handleReconnect()}
          >
            {t("mcp.reconnectAll")}
          </Button>
        </div>
      </div>

      {scope.error && <div className="ev-error-banner">{scope.error}</div>}

      {jsonPanelOpen && (
        <McpJsonPanel
          isProject={isProject}
          globalServers={scope.globalServers}
          projectServers={scope.projectServers}
          effectiveServers={scope.effectiveServers}
          onImport={handleImportJson}
          onClose={() => setJsonPanelOpen(false)}
        />
      )}

      {formState && (
        <McpServerForm
          initialForm={formState}
          isProject={isProject}
          onSubmit={handleFormSubmit}
          onCancel={() => setFormState(undefined)}
        />
      )}

      {scope.loading && scope.statuses.length === 0 ? (
        <div className="ev-empty-box">{t("mcp.loading")}</div>
      ) : scope.statuses.length === 0 ? (
        <div className="ev-empty-box">{t(isProject ? "mcp.emptyProject" : "mcp.emptyGlobal")}</div>
      ) : (
        <div className="ev-settings-list">
          {scope.statuses.map((srv) => (
            <McpServerRow
              key={`${projectId ?? "global"}:${srv.name}`}
              server={srv}
              isProject={isProject}
              isBusy={Boolean(mutatingServers[srv.name] || oauthMutatingServers[srv.name])}
              isReconnecting={reconnectingServer === srv.name}
              effectiveConfig={scope.effectiveServers[srv.name] ?? scope.globalServers[srv.name]}
              ownConfig={scope.projectServers[srv.name] ?? scope.effectiveServers[srv.name]}
              globalConfig={scope.globalServers[srv.name]}
              activeOAuth={oauthSession?.serverName === srv.name ? oauthSession : undefined}
              onToggleEnabled={(server, enabled) => patchServer(server, { enabled })}
              onToggleRole={(server, role, checked) =>
                patchServer(
                  server,
                  buildRoleTogglePatch(
                    server,
                    role,
                    checked,
                    isProject && server.scope !== "project",
                  ),
                )
              }
              onToolExposureChange={(server, toolName, nextValue) =>
                void handleToolExposureChange(server, toolName, nextValue)
              }
              onReconnect={(serverName) => void handleReconnect(serverName)}
              onEdit={(server) =>
                setFormState(
                  formFromConfig(
                    server.name,
                    scope.effectiveServers[server.name] ?? scope.globalServers[server.name],
                    server,
                  ),
                )
              }
              onDelete={(server) => void removeOrRevert(server)}
              onFetchLogs={scope.getLogs}
              onStartOAuth={(serverName) => void startOAuth(serverName)}
              onLogoutOAuth={(serverName) => void logoutOAuth(serverName)}
              onCancelOAuth={() => void cancelOAuth()}
              onSubmitOAuthRedirect={() => void submitOAuthRedirect()}
              onSetOAuthRedirectInput={setOAuthRedirectInput}
            />
          ))}
        </div>
      )}
    </div>
  );
}
