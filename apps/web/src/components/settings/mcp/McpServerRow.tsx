import {
  DeleteIcon,
  EditIcon,
  KeyIcon,
  LogoutIcon,
  RefreshIcon,
  TerminalIcon,
  UndoIcon,
} from "@earendil-works/elanor-icons-react";
import { Button, Checkbox, Switch } from "@earendil-works/elanor-react";
import {
  isMcpHttpConfig,
  type McpLogsResponse,
  type McpServerSnapshotPayload,
} from "@eevee/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../../lib/i18n.ts";
import { EvTooltip } from "../../EvTooltip.tsx";
import type { OAuthUiSession } from "../useMcpOAuth.ts";
import {
  DEFAULT_EXPOSURE,
  type ServerLogsState,
  scopeBadge,
  statusMeta,
  targetSummary,
} from "./codec.ts";
import { LogsDrawer, OAuthSessionBox, ToolsDrawer } from "./McpServerDrawers.tsx";

export type McpServerRowProps = {
  readonly server: McpServerSnapshotPayload;
  readonly isProject: boolean;
  readonly isBusy: boolean;
  readonly isReconnecting: boolean;
  readonly effectiveConfig: Record<string, unknown> | undefined;
  readonly ownConfig: Record<string, unknown> | undefined;
  readonly globalConfig: Record<string, unknown> | undefined;
  readonly activeOAuth: OAuthUiSession | undefined;
  readonly onToggleEnabled: (server: McpServerSnapshotPayload, enabled: boolean) => void;
  readonly onToggleRole: (
    server: McpServerSnapshotPayload,
    role: "router" | "worker",
    checked: boolean,
  ) => void;
  readonly onToolExposureChange: (
    server: McpServerSnapshotPayload,
    toolName: string,
    nextValue: string,
  ) => void;
  readonly onReconnect: (serverName: string) => void;
  readonly onEdit: (server: McpServerSnapshotPayload) => void;
  readonly onDelete: (server: McpServerSnapshotPayload) => void;
  readonly onFetchLogs: (serverName: string) => Promise<McpLogsResponse>;
  readonly onStartOAuth: (serverName: string) => void;
  readonly onLogoutOAuth: (serverName: string) => void;
  readonly onCancelOAuth: () => void;
  readonly onSubmitOAuthRedirect: () => void;
  readonly onSetOAuthRedirectInput: (value: string) => void;
};

export function McpServerRow({
  server,
  isProject,
  isBusy,
  isReconnecting,
  effectiveConfig,
  ownConfig,
  globalConfig,
  activeOAuth,
  onToggleEnabled,
  onToggleRole,
  onToolExposureChange,
  onReconnect,
  onEdit,
  onDelete,
  onFetchLogs,
  onStartOAuth,
  onLogoutOAuth,
  onCancelOAuth,
  onSubmitOAuthRedirect,
  onSetOAuthRedirectInput,
}: McpServerRowProps) {
  const { t } = useI18n();
  const idPrefix = useId();
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logState, setLogState] = useState<ServerLogsState | undefined>(undefined);
  const logReqIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchLogs = async () => {
    const reqId = ++logReqIdRef.current;
    setLogState((prev) => ({
      loading: true,
      lines: prev?.lines ?? [],
      logPath: prev?.logPath,
    }));
    try {
      const res = await onFetchLogs(server.name);
      if (!mountedRef.current || logReqIdRef.current !== reqId) return;
      setLogState({ loading: false, lines: res.lines, logPath: res.logPath });
    } catch (err) {
      if (!mountedRef.current || logReqIdRef.current !== reqId) return;
      setLogState((prev) => ({
        loading: false,
        lines: prev?.lines ?? [],
        logPath: prev?.logPath,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const toggleLogs = () => {
    const nextOpen = !logsExpanded;
    setLogsExpanded(nextOpen);
    if (nextOpen) void fetchLogs();
  };

  const meta = statusMeta(server.status);
  const scope = scopeBadge(server.scope);
  const transport = server.transport ?? (isMcpHttpConfig(effectiveConfig) ? "http" : "stdio");
  const exposure = server.exposure ?? DEFAULT_EXPOSURE;
  const roleRouter = server.roles?.router !== false;
  const roleWorker = server.roles?.worker !== false;
  const toolsList = server.tools ?? [];
  const canOAuth = transport === "http";
  const needsAuth = server.status === "auth_required" || server.authRequired === true;
  const previewTarget = targetSummary(effectiveConfig);

  return (
    <div className="ev-settings-row">
      <div className="ev-mcp-row-header">
        <div className="ev-mcp-row-title-col">
          <div className="ev-mcp-badges">
            <span className="ev-dot" data-stage={meta.stage} />
            <strong className="ev-mono">{server.name}</strong>
            <span className="eevee-badge" data-tone={meta.tone}>
              {meta.label}
            </span>
            {isProject && scope && server.scope !== "global" && (
              <span className="eevee-badge" data-tone={scope.tone}>
                {scope.label}
              </span>
            )}
          </div>
          <div className="ev-mcp-row-sub">
            <span className="ev-mono">
              {transport} · {exposure}
              {server.hasResources ? " · resources" : ""}
            </span>
            {previewTarget && (
              <>
                <span>·</span>
                <EvTooltip content={previewTarget} side="top">
                  <span className="ev-mono ev-truncate">{previewTarget}</span>
                </EvTooltip>
              </>
            )}
            {server.description && (
              <>
                <span>·</span>
                <span className="ev-truncate">{server.description}</span>
              </>
            )}
          </div>
        </div>

        <div className="ev-mcp-row-controls">
          <EvTooltip content={t("mcp.row.rolesTitle")} side="top">
            <div className="ev-mcp-roles-inline">
              <div className="ev-mcp-role-check">
                <Checkbox.Root
                  id={`${idPrefix}-router`}
                  checked={roleRouter}
                  disabled={isBusy}
                  onCheckedChange={(checked) => onToggleRole(server, "router", checked === true)}
                >
                  <Checkbox.Indicator />
                </Checkbox.Root>
                <label htmlFor={`${idPrefix}-router`}>Router</label>
              </div>
              <div className="ev-mcp-role-check">
                <Checkbox.Root
                  id={`${idPrefix}-worker`}
                  checked={roleWorker}
                  disabled={isBusy}
                  onCheckedChange={(checked) => onToggleRole(server, "worker", checked === true)}
                >
                  <Checkbox.Indicator />
                </Checkbox.Root>
                <label htmlFor={`${idPrefix}-worker`}>Worker</label>
              </div>
            </div>
          </EvTooltip>

          <EvTooltip content={t(server.enabled ? "common.enabled" : "common.disabled")} side="top">
            <div className="ev-mcp-enable-switch">
              <Switch.Root
                checked={server.enabled}
                disabled={isBusy}
                aria-label={t(server.enabled ? "mcp.row.disableAria" : "mcp.row.enableAria", {
                  name: server.name,
                })}
                onCheckedChange={(checked) => onToggleEnabled(server, checked)}
              >
                <Switch.Thumb />
              </Switch.Root>
            </div>
          </EvTooltip>
        </div>
      </div>

      <div className="ev-mcp-row-actions">
        {canOAuth && (
          <>
            <Button
              type="button"
              hierarchy={needsAuth ? "primary" : "secondary"}
              density="compact"
              iconStart={<KeyIcon width={14} height={14} />}
              disabled={!server.enabled || isBusy}
              onClick={() => onStartOAuth(server.name)}
            >
              {t("mcp.row.oauthLogin")}
            </Button>
            <Button
              type="button"
              hierarchy="tertiary"
              density="compact"
              iconStart={<LogoutIcon width={14} height={14} />}
              disabled={isBusy}
              onClick={() => onLogoutOAuth(server.name)}
            >
              {t("mcp.row.oauthLogout")}
            </Button>
          </>
        )}
        <Button
          type="button"
          hierarchy="secondary"
          density="compact"
          iconStart={<RefreshIcon width={14} height={14} />}
          disabled={!server.enabled || isBusy}
          pending={isReconnecting}
          onClick={() => onReconnect(server.name)}
        >
          {t("mcp.row.reconnect")}
        </Button>
        <Button
          type="button"
          hierarchy="secondary"
          density="compact"
          iconStart={<EditIcon width={14} height={14} />}
          disabled={isBusy}
          onClick={() => onEdit(server)}
        >
          {t("common.edit")}
        </Button>
        <Button
          type="button"
          hierarchy="secondary"
          density="compact"
          aria-expanded={toolsExpanded}
          onClick={() => setToolsExpanded((prev) => !prev)}
        >
          {t("mcp.row.toolsCount", { count: toolsList.length })}
        </Button>
        <Button
          type="button"
          hierarchy="secondary"
          density="compact"
          iconStart={<TerminalIcon width={14} height={14} />}
          aria-expanded={logsExpanded}
          onClick={toggleLogs}
        >
          {t("mcp.row.viewLogs")}
        </Button>
        {(!isProject || server.scope === "project" || server.scope === "override") && (
          <Button
            type="button"
            hierarchy="tertiary"
            semantic="negative"
            density="compact"
            iconStart={
              isProject && server.scope === "override" ? (
                <UndoIcon width={14} height={14} />
              ) : (
                <DeleteIcon width={14} height={14} />
              )
            }
            disabled={isBusy}
            onClick={() => onDelete(server)}
          >
            {t(isProject && server.scope === "override" ? "mcp.row.revertGlobal" : "common.delete")}
          </Button>
        )}
      </div>

      {server.error && <div className="ev-error-banner">{server.error}</div>}

      {activeOAuth && (
        <OAuthSessionBox
          session={activeOAuth}
          onCancel={onCancelOAuth}
          onSubmitRedirect={onSubmitOAuthRedirect}
          onSetRedirectInput={onSetOAuthRedirectInput}
        />
      )}

      {toolsExpanded && (
        <ToolsDrawer
          server={server}
          isProject={isProject}
          isBusy={isBusy}
          ownConfig={ownConfig}
          globalConfig={globalConfig}
          onToolExposureChange={onToolExposureChange}
        />
      )}

      {logsExpanded && (
        <LogsDrawer
          server={server}
          logState={logState}
          onRefresh={() => void fetchLogs()}
          onClose={() => setLogsExpanded(false)}
        />
      )}
    </div>
  );
}
