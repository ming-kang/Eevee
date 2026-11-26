import { AddIcon, DeleteIcon, RefreshIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Card,
  Field,
  Heading,
  IconButton,
  Input,
  Stack,
  Text,
  TextArea,
} from "@earendil-works/elanor-react";
import type { McpStateResponse } from "@eevee/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";

export function McpTab() {
  const [state, setState] = useState<McpStateResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [commandOrUrl, setCommandOrUrl] = useState("");
  const [argsText, setArgsText] = useState("");
  const [exposure, setExposure] = useState<"deferred" | "direct" | "codemode" | "hidden">(
    "deferred",
  );
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setState(await api.getMcpState());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reconnect = async (server?: string) => {
    setReconnecting(true);
    setError(undefined);
    try {
      await api.reconnectMcp(server ? { server } : {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReconnecting(false);
    }
  };

  const remove = async (serverName: string) => {
    setError(undefined);
    try {
      setState(await api.deleteMcpServer(serverName));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const target = commandOrUrl.trim();
    if (!trimmedName || !target) {
      setError("请填写服务器名称与命令/URL。");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const config: Record<string, unknown> =
        transport === "stdio"
          ? {
              command: target,
              args: argsText
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
              exposure,
            }
          : { url: target, exposure };
      setState(await api.upsertMcpServer(trimmedName, { config }));
      setName("");
      setCommandOrUrl("");
      setArgsText("");
      setShowAdd(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const statuses = state?.status ?? [];

  return (
    <Stack direction="column" gap="medium">
      <Stack direction="row" gap="small" align="center" style={{ justifyContent: "space-between" }}>
        <Heading level={2} size={5}>
          共享 MCP 服务（{statuses.length}）
        </Heading>
        <Stack direction="row" gap="xSmall">
          <Button
            hierarchy="secondary"
            density="compact"
            iconStart={<AddIcon width={15} height={15} />}
            onClick={() => setShowAdd((prev) => !prev)}
          >
            添加服务
          </Button>
          <Button
            hierarchy="secondary"
            density="compact"
            iconStart={<RefreshIcon width={15} height={15} />}
            pending={reconnecting || loading}
            onClick={() => void reconnect()}
          >
            全部重连
          </Button>
        </Stack>
      </Stack>

      {error && <div className="eevee-error-banner">{error}</div>}

      {showAdd && (
        <Card>
          <form onSubmit={(event) => void handleAdd(event)}>
            <Stack direction="column" gap="small">
              <Stack direction="row" gap="small" style={{ flexWrap: "wrap" }}>
                <Field.Root style={{ flex: 1, minWidth: 160 }}>
                  <Field.Label>服务名</Field.Label>
                  <Input
                    type="text"
                    value={name}
                    onValueChange={(value) => setName(value)}
                    placeholder="例如：github"
                  />
                </Field.Root>
                <Field.Root style={{ width: 130 }}>
                  <Field.Label>传输类型</Field.Label>
                  <select
                    className="eevee-project-select"
                    value={transport}
                    onChange={(event) =>
                      setTransport(event.target.value === "http" ? "http" : "stdio")
                    }
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">HTTP</option>
                  </select>
                </Field.Root>
                <Field.Root style={{ width: 140 }}>
                  <Field.Label>暴露方式</Field.Label>
                  <select
                    className="eevee-project-select"
                    value={exposure}
                    onChange={(event) =>
                      setExposure(
                        event.target.value as "deferred" | "direct" | "codemode" | "hidden",
                      )
                    }
                  >
                    <option value="deferred">deferred</option>
                    <option value="direct">direct</option>
                    <option value="codemode">codemode</option>
                    <option value="hidden">hidden</option>
                  </select>
                </Field.Root>
              </Stack>
              <Field.Root>
                <Field.Label>{transport === "stdio" ? "可执行命令" : "服务 URL"}</Field.Label>
                <Input
                  type="text"
                  value={commandOrUrl}
                  onValueChange={(value) => setCommandOrUrl(value)}
                  placeholder={transport === "stdio" ? "npx" : "https://mcp.example.com/mcp"}
                />
              </Field.Root>
              {transport === "stdio" && (
                <Field.Root>
                  <Field.Label>参数（每行一个，可选）</Field.Label>
                  <TextArea
                    monospace
                    rows={3}
                    value={argsText}
                    onValueChange={(value) => setArgsText(value)}
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                  />
                </Field.Root>
              )}
              <Stack direction="row" gap="xSmall">
                <Button type="submit" hierarchy="primary" density="compact" pending={saving}>
                  保存并连接
                </Button>
                <Button
                  type="button"
                  hierarchy="secondary"
                  density="compact"
                  onClick={() => setShowAdd(false)}
                >
                  取消
                </Button>
              </Stack>
            </Stack>
          </form>
        </Card>
      )}

      {statuses.length === 0 ? (
        <Text style={{ color: "var(--semantic-color-text-secondary)" }}>
          尚未配置共享 MCP 服务。添加后会实时同步到所有已打开的项目。
        </Text>
      ) : (
        statuses.map((srv) => (
          <Card key={srv.name} style={{ padding: 12 }}>
            <Stack direction="column" gap="xxSmall">
              <Stack
                direction="row"
                gap="small"
                align="center"
                style={{ justifyContent: "space-between" }}
              >
                <Stack direction="row" gap="xSmall" align="center">
                  <strong className="eevee-mono">{srv.name}</strong>
                  <span
                    className="eevee-badge"
                    data-tone={
                      srv.status === "connected"
                        ? "positive"
                        : srv.status === "failed"
                          ? "negative"
                          : "warning"
                    }
                  >
                    {srv.status}
                  </span>
                  <span className="eevee-badge">{srv.toolCount} tools</span>
                </Stack>
                <Stack direction="row" gap="xxSmall">
                  <Button
                    hierarchy="secondary"
                    density="compact"
                    onClick={() => void reconnect(srv.name)}
                  >
                    重连
                  </Button>
                  <IconButton aria-label={`删除 ${srv.name}`} onClick={() => void remove(srv.name)}>
                    <DeleteIcon width={16} height={16} />
                  </IconButton>
                </Stack>
              </Stack>
              {srv.error && <div className="eevee-error-banner">{srv.error}</div>}
            </Stack>
          </Card>
        ))
      )}
    </Stack>
  );
}
