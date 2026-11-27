import { KeyIcon, SearchIcon } from "@earendil-works/elanor-icons-react";
import { Button, Field, Text } from "@earendil-works/elanor-react";
import { type BuiltinProviderCatalogItem, providerBaseUrlPlaceholder } from "@eevee/protocol";
import type { Dispatch, FormEvent } from "react";
import { BaseUrlField } from "../BaseUrlField.tsx";
import { HeadersEditor } from "../HeadersEditor.tsx";
import { SecretRevealInput } from "../SecretRevealInput.tsx";
import type { AddProviderAction, BuiltinProviderDraft } from "./add-provider-state.ts";

export type AddBuiltinProviderFormProps = {
  readonly builtinProviders: readonly BuiltinProviderCatalogItem[];
  readonly selectedBuiltin: BuiltinProviderCatalogItem | undefined;
  readonly loadingCatalog: boolean;
  readonly saving: boolean;
  readonly draft: BuiltinProviderDraft;
  readonly dispatch: Dispatch<AddProviderAction>;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onOAuth: () => void;
};

export function AddBuiltinProviderForm({
  builtinProviders,
  selectedBuiltin,
  loadingCatalog,
  saving,
  draft,
  dispatch,
  onSubmit,
  onOAuth,
}: AddBuiltinProviderFormProps) {
  const query = draft.filter.trim().toLowerCase();
  const visibleBuiltins = query
    ? builtinProviders.filter((item) =>
        `${item.id} ${item.name} ${item.baseUrl ?? ""} ${item.apis.join(" ")}`
          .toLowerCase()
          .includes(query),
      )
    : builtinProviders;

  return (
    <div className="ev-catalog-picker">
      <div className="ev-catalog-list-pane">
        <div className="ev-probe-search">
          <SearchIcon width={14} height={14} />
          <input
            className="ev-raw-input"
            value={draft.filter}
            placeholder="搜索内置 Provider…"
            onChange={(event) =>
              dispatch({ type: "patchBuiltin", patch: { filter: event.target.value } })
            }
          />
        </div>
        <div className="ev-catalog-list">
          {loadingCatalog && builtinProviders.length === 0 ? (
            <Text className="ev-inline-hint">加载目录中…</Text>
          ) : visibleBuiltins.length === 0 ? (
            <Text className="ev-inline-hint">无匹配的内置 Provider。</Text>
          ) : (
            visibleBuiltins.map((item) => (
              <button
                type="button"
                key={item.id}
                className="ev-catalog-item"
                data-active={item.id === selectedBuiltin?.id}
                onClick={() => dispatch({ type: "selectBuiltin", id: item.id })}
              >
                <div className="ev-provider-item-head">
                  <span className="ev-dot" data-stage={item.configured ? "done" : "idle"} />
                  <strong className="ev-truncate">{item.name}</strong>
                  <span className="ev-mono ev-inline-muted">{item.id}</span>
                </div>
                <div className="ev-provider-item-badges">
                  <span className="ev-inline-muted ev-num">{item.modelCount} 模型</span>
                  {item.configured && (
                    <span className="eevee-badge" data-tone="positive">
                      已配置
                    </span>
                  )}
                  {item.hasConfigOverride && (
                    <span className="eevee-badge" data-tone="warning">
                      已覆盖
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="ev-catalog-config">
        {selectedBuiltin ? (
          <form id="ev-add-builtin-form" onSubmit={onSubmit} className="ev-form-stack">
            <div className="ev-editor-section">
              <div className="ev-provider-item-head">
                <strong style={{ fontSize: 15 }}>{selectedBuiltin.name}</strong>
                <span className="ev-mono ev-inline-muted">{selectedBuiltin.id}</span>
              </div>
              {selectedBuiltin.baseUrl && (
                <Text className="ev-inline-hint">
                  默认端点：<span className="ev-mono">{selectedBuiltin.baseUrl}</span>
                </Text>
              )}
              {selectedBuiltin.apis.length > 0 && (
                <Text className="ev-inline-hint">
                  协议：<span className="ev-mono">{selectedBuiltin.apis.join(", ")}</span>
                </Text>
              )}
            </div>

            <div className="ev-editor-section">
              <div className="ev-editor-section-title">身份验证</div>
              {selectedBuiltin.authMethods.apiKey && (
                <Field.Root>
                  <Field.Label>API Key</Field.Label>
                  <SecretRevealInput
                    value={draft.apiKey}
                    revealed={draft.revealKey}
                    onValueChange={(apiKey) =>
                      dispatch({ type: "patchBuiltin", patch: { apiKey } })
                    }
                    onRevealedChange={(revealKey) =>
                      dispatch({ type: "patchBuiltin", patch: { revealKey } })
                    }
                    placeholder="输入 API Key（或 $ENV_VAR / !cmd）"
                  />
                </Field.Root>
              )}
              {selectedBuiltin.authMethods.oauth && (
                <div className="ev-inline-actions">
                  <Button
                    type="button"
                    hierarchy="secondary"
                    density="compact"
                    iconStart={<KeyIcon width={14} height={14} />}
                    pending={saving}
                    onClick={onOAuth}
                  >
                    {selectedBuiltin.authMethods.oauthLabel ?? "开始 OAuth 登录"}
                  </Button>
                </div>
              )}
            </div>

            <div className="ev-editor-section">
              <div className="ev-editor-section-title">网关覆盖（可选）</div>
              <BaseUrlField
                label="自定义 Base URL"
                baseUrl={draft.baseUrl}
                onValueChange={(baseUrl) => dispatch({ type: "patchBuiltin", patch: { baseUrl } })}
                api={selectedBuiltin.apis[0]}
                placeholder={
                  selectedBuiltin.baseUrl ?? providerBaseUrlPlaceholder(selectedBuiltin.apis[0])
                }
                previewPrefix="请求 URL 预览："
                warningText=" 检测到可能的 /v1 重复"
              />
              <Field.Root>
                <Field.Label>自定义请求头（KEY=VALUE）</Field.Label>
                <HeadersEditor
                  rows={draft.headers}
                  onChange={(headers) => dispatch({ type: "patchBuiltin", patch: { headers } })}
                />
              </Field.Root>
            </div>
          </form>
        ) : (
          <Text className="ev-inline-hint">从左侧选择一个内置 Provider。</Text>
        )}
      </div>
    </div>
  );
}
