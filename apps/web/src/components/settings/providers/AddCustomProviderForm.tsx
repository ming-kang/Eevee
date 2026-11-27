import { CloudDownloadIcon } from "@earendil-works/elanor-icons-react";
import { Button, Field, Input, Switch, Text } from "@earendil-works/elanor-react";
import type { Dispatch, FormEvent } from "react";
import { BaseUrlField, BaseUrlPreview } from "../BaseUrlField.tsx";
import { HeadersEditor } from "../HeadersEditor.tsx";
import { ModelProbeSelector } from "../ModelProbeSelector.tsx";
import { baseUrlPlaceholder } from "../provider-utils.ts";
import type {
  AddProviderAction,
  CustomProviderDraft,
  ProbeModelsDraft,
} from "./add-provider-state.ts";

export type AddCustomProviderFormProps = {
  readonly supportedApis: readonly string[];
  readonly draft: CustomProviderDraft;
  readonly probe: ProbeModelsDraft;
  readonly dispatch: Dispatch<AddProviderAction>;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onProbe: () => void;
};

export function AddCustomProviderForm({
  supportedApis,
  draft,
  probe,
  dispatch,
  onSubmit,
  onProbe,
}: AddCustomProviderFormProps) {
  const apiOptions = supportedApis.length > 0 ? supportedApis : [draft.api];

  return (
    <form id="ev-add-custom-form" onSubmit={onSubmit} className="ev-form-stack">
      <section className="ev-editor-section">
        <div className="ev-editor-section-title">基础与连接</div>
        <div className="ev-model-form-grid">
          <Field.Root>
            <Field.Label>Provider ID</Field.Label>
            <Input
              type="text"
              value={draft.id}
              onValueChange={(id) => dispatch({ type: "patchCustom", patch: { id } })}
              placeholder="my-openai-proxy"
            />
          </Field.Root>
          <Field.Root>
            <Field.Label>显示名称（可选）</Field.Label>
            <Input
              type="text"
              value={draft.name}
              onValueChange={(name) => dispatch({ type: "patchCustom", patch: { name } })}
              placeholder="留空则使用 Provider ID"
            />
          </Field.Root>
          <Field.Root>
            <Field.Label>协议 API</Field.Label>
            <select
              className="ev-select"
              value={draft.api}
              onChange={(event) =>
                dispatch({ type: "patchCustom", patch: { api: event.target.value } })
              }
            >
              {apiOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field.Root>
          <BaseUrlField
            label="Base URL"
            baseUrl={draft.baseUrl}
            onValueChange={(baseUrl) => dispatch({ type: "patchCustom", patch: { baseUrl } })}
            api={draft.api}
            placeholder={baseUrlPlaceholder(draft.api)}
            hidePreview
          />
        </div>
        <BaseUrlPreview
          api={draft.api}
          baseUrl={draft.baseUrl}
          previewPrefix="有效请求 URL 预览："
          warningText=" 检测到可能的 /v1 重复，请检查 Base URL"
        />
      </section>

      <section className="ev-editor-section">
        <div className="ev-editor-section-title">鉴权与请求头</div>
        <Field.Root>
          <Field.Label>API Key（支持明文、$ENV_VAR 或 !cmd）</Field.Label>
          <div className="ev-key-input-row">
            <Input
              type={draft.revealKey ? "text" : "password"}
              value={draft.apiKey}
              onValueChange={(apiKey) => dispatch({ type: "patchCustom", patch: { apiKey } })}
              placeholder="sk-... 或 $MY_API_KEY 或 !op read ..."
            />
            <Button
              type="button"
              hierarchy="secondary"
              density="compact"
              onClick={() =>
                dispatch({ type: "patchCustom", patch: { revealKey: !draft.revealKey } })
              }
            >
              {draft.revealKey ? "隐藏" : "显示"}
            </Button>
          </div>
        </Field.Root>
        <div className="ev-toggle-field">
          <span>通过 Authorization: Bearer 请求头传递 API Key（authHeader）</span>
          <Switch.Root
            checked={draft.authHeader}
            onCheckedChange={(authHeader) =>
              dispatch({ type: "patchCustom", patch: { authHeader } })
            }
          >
            <Switch.Thumb />
          </Switch.Root>
        </div>
        <Field.Root>
          <Field.Label>自定义请求头（KEY=VALUE）</Field.Label>
          <HeadersEditor
            rows={draft.headers}
            onChange={(headers) => dispatch({ type: "patchCustom", patch: { headers } })}
          />
        </Field.Root>
      </section>

      <section className="ev-editor-section">
        <div className="ev-editor-section-head">
          <div className="ev-editor-section-title">探测模型（可选，一步导入）</div>
          <Button
            type="button"
            hierarchy="secondary"
            density="compact"
            iconStart={<CloudDownloadIcon width={14} height={14} />}
            pending={probe.probing}
            onClick={onProbe}
          >
            探测模型
          </Button>
        </div>
        {probe.catalogUrl && (
          <Text className="ev-inline-hint">
            模型目录：<span className="ev-mono">{probe.catalogUrl}</span>
          </Text>
        )}
        {probe.error && <div className="ev-error-banner">{probe.error}</div>}
        {probe.truncated && (
          <div>
            <span className="eevee-badge" data-tone="warning">
              探测结果已截断，建议先筛选再勾选
            </span>
          </div>
        )}
        {probe.models.length > 0 && (
          <ModelProbeSelector
            models={probe.models}
            selected={probe.selected}
            onSelectedChange={(selected) => dispatch({ type: "patchProbe", patch: { selected } })}
            filter={probe.filter}
            onFilterChange={(filter) => dispatch({ type: "patchProbe", patch: { filter } })}
            filterPlaceholder="筛选探测到的模型…"
            variant="list"
          />
        )}
      </section>
    </form>
  );
}
