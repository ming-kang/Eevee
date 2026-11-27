import { OpenInNewIcon, RefreshIcon } from "@earendil-works/elanor-icons-react";
import { Button, Input, Link, Text } from "@earendil-works/elanor-react";
import type { McpServerSnapshotPayload } from "@eevee/protocol";
import { useI18n } from "../../../lib/i18n.ts";
import type { OAuthUiSession } from "../useMcpOAuth.ts";
import {
  DEFAULT_EXPOSURE,
  EXPOSURE_OPTIONS,
  getExplicitToolExposure,
  type ServerLogsState,
} from "./codec.ts";

export function OAuthSessionBox({
  session,
  onCancel,
  onSubmitRedirect,
  onSetRedirectInput,
}: {
  readonly session: OAuthUiSession;
  readonly onCancel: () => void;
  readonly onSubmitRedirect: () => void;
  readonly onSetRedirectInput: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ev-mcp-oauth-box">
      <div className="ev-settings-head">
        <strong>{t("mcp.oauth.flowTitle", { name: session.serverName })}</strong>
        <Button type="button" hierarchy="secondary" density="compact" onClick={onCancel}>
          {t(session.done || session.error ? "common.close" : "common.cancel")}
        </Button>
      </div>
      {session.instructions && (
        <Text style={{ margin: 0, fontSize: "0.8125rem" }}>{session.instructions}</Text>
      )}
      {session.authUrl && (
        <div className="ev-mcp-oauth-url">
          <Link href={session.authUrl} target="_blank" rel="noreferrer noopener">
            {t("mcp.oauth.openAuthPage")} <OpenInNewIcon width={13} height={13} />
          </Link>
          <span className="ev-mono ev-inline-muted ev-truncate">{session.authUrl}</span>
        </div>
      )}
      {session.progress.length > 0 && (
        <div className="ev-mcp-oauth-progress">
          {session.progress.map((entry) => (
            <div key={entry.id} className="ev-inline-muted">
              {entry.message}
            </div>
          ))}
        </div>
      )}
      {session.authUrl && !session.done && (
        <div className="ev-mcp-oauth-input-row">
          <Input
            type="text"
            value={session.redirectInput}
            disabled={session.submittingInput}
            placeholder={
              session.redirectHint
                ? t("mcp.oauth.redirectPlaceholderWithHint", { hint: session.redirectHint })
                : t("mcp.oauth.redirectPlaceholder")
            }
            onValueChange={onSetRedirectInput}
          />
          <Button
            type="button"
            hierarchy="primary"
            density="compact"
            disabled={session.redirectInput.trim().length === 0}
            pending={session.submittingInput}
            onClick={onSubmitRedirect}
          >
            {t("mcp.oauth.submitRedirect")}
          </Button>
        </div>
      )}
      {session.done && (
        <div>
          <span className="eevee-badge" data-tone="positive">
            {t("mcp.oauth.authorizedNotice")}
          </span>
        </div>
      )}
      {session.error && <div className="ev-error-banner">{session.error}</div>}
    </div>
  );
}

export function ToolsDrawer({
  server,
  isProject,
  isBusy,
  ownConfig,
  globalConfig,
  onToolExposureChange,
}: {
  readonly server: McpServerSnapshotPayload;
  readonly isProject: boolean;
  readonly isBusy: boolean;
  readonly ownConfig: Record<string, unknown> | undefined;
  readonly globalConfig: Record<string, unknown> | undefined;
  readonly onToolExposureChange: (
    server: McpServerSnapshotPayload,
    toolName: string,
    nextValue: string,
  ) => void;
}) {
  const { t } = useI18n();
  const exposure = server.exposure ?? DEFAULT_EXPOSURE;
  const toolsList = server.tools ?? [];
  const explicitTools = getExplicitToolExposure(ownConfig);
  const globalToolExposure = isProject ? getExplicitToolExposure(globalConfig) : {};

  return (
    <div className="ev-mcp-drawer">
      {server.instructions && (
        <div className="ev-mcp-instructions">
          <strong>Server Instructions</strong>
          <pre className="ev-pre" style={{ maxHeight: 120 }}>
            {server.instructions}
          </pre>
        </div>
      )}
      {toolsList.length === 0 ? (
        <Text className="ev-inline-hint">
          {server.status === "connected" || server.status === "degraded"
            ? t("mcp.tools.emptyConnected")
            : t("mcp.tools.emptyDisconnected")}
        </Text>
      ) : (
        <div className="ev-mcp-tools-table-wrap">
          <table className="ev-mcp-tools-table">
            <thead>
              <tr>
                <th>{t("mcp.tools.colName")}</th>
                <th>{t("mcp.tools.colDescription")}</th>
                <th>{t("mcp.tools.colEffectiveExposure")}</th>
                <th>{t("mcp.tools.colOverride")}</th>
              </tr>
            </thead>
            <tbody>
              {toolsList.map((tool) => {
                const explicit = explicitTools[tool.name];
                const globalExplicit = globalToolExposure[tool.name];
                const defaultLabel =
                  isProject && globalExplicit !== undefined
                    ? t("mcp.tools.inheritGlobal", { exposure: globalExplicit })
                    : t("mcp.tools.defaultExposure", { exposure });

                return (
                  <tr key={tool.name}>
                    <td className="ev-mono">{tool.name}</td>
                    <td className="ev-mcp-tool-desc">
                      {tool.description ?? <span className="ev-inline-muted">—</span>}
                    </td>
                    <td>
                      <span className="eevee-badge">{tool.exposure}</span>
                    </td>
                    <td>
                      <select
                        className="ev-select"
                        aria-label={t("mcp.tools.exposureAriaLabel", { name: tool.name })}
                        disabled={isBusy}
                        value={explicit ?? ""}
                        onChange={(event) =>
                          onToolExposureChange(server, tool.name, event.target.value)
                        }
                      >
                        <option value="">{defaultLabel}</option>
                        {EXPOSURE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.value}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function LogsDrawer({
  server,
  logState,
  onRefresh,
  onClose,
}: {
  readonly server: McpServerSnapshotPayload;
  readonly logState: ServerLogsState | undefined;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const logOutput =
    logState?.loading && logState.lines.length === 0
      ? server.recentLogs && server.recentLogs.length > 0
        ? server.recentLogs.join("\n")
        : t("mcp.logs.loading")
      : logState && logState.lines.length > 0
        ? logState.lines.join("\n")
        : server.recentLogs && server.recentLogs.length > 0
          ? server.recentLogs.join("\n")
          : t("mcp.logs.empty");

  return (
    <div className="ev-mcp-drawer">
      <div className="ev-mcp-log-head">
        <span className="ev-mono ev-inline-muted ev-truncate">
          {logState?.logPath ?? t("mcp.logs.defaultTitle")}
        </span>
        <div className="ev-inline-actions">
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<RefreshIcon width={14} height={14} />}
            pending={logState?.loading === true}
            onClick={onRefresh}
          >
            {t("mcp.logs.refresh")}
          </Button>
          <Button type="button" hierarchy="tertiary" density="compact" onClick={onClose}>
            {t("mcp.logs.collapse")}
          </Button>
        </div>
      </div>
      {logState?.error && <div className="ev-error-banner">{logState.error}</div>}
      <pre className="ev-pre" style={{ maxHeight: 220 }}>
        {logOutput}
      </pre>
    </div>
  );
}
