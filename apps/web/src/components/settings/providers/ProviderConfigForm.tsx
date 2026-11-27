import { Button, Field, Heading, Input, Switch } from "@earendil-works/elanor-react";
import type { ProviderDetail } from "@eevee/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { BaseUrlField } from "../BaseUrlField.tsx";
import { HeadersEditor } from "../HeadersEditor.tsx";
import { baseUrlPlaceholder } from "../provider-utils.ts";
import {
  buildProviderPatch,
  createProviderConfigDraft,
  type ProviderConfigDraft,
} from "./provider-config.ts";

export { buildProviderPatch, createProviderConfigDraft, type ProviderConfigDraft };

export type ProviderConfigFormProps = {
  readonly detail: ProviderDetail;
  readonly supportedApis: readonly string[];
  readonly onSaved: (provider: ProviderDetail) => Promise<void>;
  readonly onDetailError: (message: string | undefined) => void;
};

export function ProviderConfigForm({
  detail,
  supportedApis,
  onSaved,
  onDetailError,
}: ProviderConfigFormProps) {
  const [draft, setDraft] = useState<ProviderConfigDraft>(() => createProviderConfigDraft(detail));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const justSavedRef = useRef(false);

  useEffect(() => {
    setDraft(createProviderConfigDraft(detail));
    if (justSavedRef.current) {
      justSavedRef.current = false;
      setSaved(true);
    } else {
      setSaved(false);
    }
  }, [detail]);

  const patchDraft = (patch: Partial<ProviderConfigDraft>, resetSaved = true) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    if (resetSaved) setSaved(false);
  };

  const apiOptions = Array.from(
    new Set([
      ...supportedApis,
      ...(draft.api ? [draft.api] : []),
      ...(detail.api ? [detail.api] : []),
    ]),
  );

  const effectiveConfigApi =
    draft.api.trim() || detail.config?.api || detail.api || detail.models[0]?.api;
  const effectiveBaseUrl = draft.baseUrl.trim() || detail.baseUrl;
  const fallbackNote =
    !draft.baseUrl.trim() && !draft.api.trim() ? detail.connectionNote : undefined;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    onDetailError(undefined);
    setSaved(false);
    try {
      const patch = buildProviderPatch(detail, draft);
      if (Object.keys(patch).length > 0) {
        const res = await api.updateProvider(detail.id, patch);
        justSavedRef.current = true;
        await onSaved(res.provider);
      }
      setSaved(true);
    } catch (err) {
      onDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ev-settings-card">
      <div className="ev-settings-head">
        <Heading level={3} size={6}>
          连接与覆盖配置（models.json）
        </Heading>
        {saved && (
          <span className="eevee-badge" data-tone="positive">
            已保存
          </span>
        )}
      </div>
      <form onSubmit={(event) => void handleSave(event)} className="ev-form-stack">
        <div className="ev-model-form-grid">
          <Field.Root>
            <Field.Label>显示名称</Field.Label>
            <Input
              type="text"
              value={draft.name}
              onValueChange={(name) => patchDraft({ name })}
              placeholder={detail.name}
            />
          </Field.Root>
          <Field.Root>
            <Field.Label>协议 API</Field.Label>
            <select
              className="ev-select"
              value={draft.api}
              onChange={(event) => patchDraft({ api: event.target.value })}
            >
              <option value="">
                {detail.kind === "custom" ? "由模型各自指定" : "继承内置默认"}
              </option>
              {apiOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field.Root>
        </div>

        <BaseUrlField
          label="Base URL"
          baseUrl={draft.baseUrl}
          onValueChange={(baseUrl) => patchDraft({ baseUrl })}
          api={effectiveConfigApi}
          placeholder={detail.baseUrl ?? baseUrlPlaceholder(effectiveConfigApi)}
          previewBaseUrl={effectiveBaseUrl}
          fallbackNote={fallbackNote}
          previewPrefix="有效请求 URL："
          warningText=" 检测到可能的 /v1 重复，请检查 Base URL"
        />

        <Field.Root>
          <Field.Label>models.json 中的 apiKey（支持 $ENV_VAR / !cmd）</Field.Label>
          <div className="ev-key-input-row">
            <Input
              type={draft.revealApiKey ? "text" : "password"}
              value={draft.apiKey}
              disabled={draft.clearApiKey}
              onValueChange={(apiKey) =>
                patchDraft({
                  apiKey,
                  apiKeyTouched: true,
                  clearApiKey: false,
                })
              }
              placeholder={
                detail.config?.hasApiKey && !detail.config?.apiKeyRef
                  ? "已设置密钥（留空保持不变，或输入新值覆盖）"
                  : "留空则使用 auth.json 或环境变量"
              }
            />
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              onClick={() => patchDraft({ revealApiKey: !draft.revealApiKey }, false)}
            >
              {draft.revealApiKey ? "隐藏" : "显示"}
            </Button>
            {detail.config?.hasApiKey && (
              <Button
                type="button"
                hierarchy={draft.clearApiKey ? "primary" : "secondary"}
                density="compact"
                onClick={() =>
                  patchDraft({
                    clearApiKey: !draft.clearApiKey,
                    apiKey: "",
                    apiKeyTouched: true,
                  })
                }
              >
                {draft.clearApiKey ? "已标记清除" : "清除 apiKey"}
              </Button>
            )}
          </div>
        </Field.Root>

        <div className="ev-toggle-field">
          <span>使用 Authorization: Bearer 请求头发送 API Key（authHeader）</span>
          <Switch.Root
            checked={draft.authHeader}
            onCheckedChange={(authHeader) => patchDraft({ authHeader })}
          >
            <Switch.Thumb />
          </Switch.Root>
        </div>

        <Field.Root>
          <Field.Label>自定义请求头（KEY=VALUE）</Field.Label>
          <HeadersEditor rows={draft.headers} onChange={(headers) => patchDraft({ headers })} />
        </Field.Root>

        <div className="ev-inline-actions">
          <Button type="submit" hierarchy="primary" density="compact" pending={saving}>
            保存 Provider 配置
          </Button>
        </div>
      </form>
    </div>
  );
}
