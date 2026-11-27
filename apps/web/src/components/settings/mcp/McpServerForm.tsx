import { CloseIcon } from "@earendil-works/elanor-icons-react";
import {
  Button,
  Checkbox,
  Field,
  Heading,
  IconButton,
  Input,
  SegmentedControl,
  Switch,
  TextArea,
} from "@earendil-works/elanor-react";
import { type FormEvent, useEffect, useId, useReducer, useState } from "react";
import { HeadersEditor } from "../HeadersEditor.tsx";
import { EXPOSURE_OPTIONS, normalizeExposure, type ServerFormState } from "./codec.ts";
import { McpOAuthFields } from "./McpOAuthFields.tsx";

type ServerFormAction =
  | { readonly type: "patch"; readonly patch: Partial<ServerFormState> }
  | { readonly type: "reset"; readonly initial: ServerFormState };

function serverFormReducer(state: ServerFormState, action: ServerFormAction): ServerFormState {
  switch (action.type) {
    case "patch":
      return { ...state, ...action.patch };
    case "reset":
      return action.initial;
  }
}

export type McpServerFormProps = {
  readonly initialForm: ServerFormState;
  readonly isProject: boolean;
  readonly isGlobalOverrideTarget: boolean;
  readonly onSubmit: (form: ServerFormState) => Promise<void>;
  readonly onCancel: () => void;
};

export function McpServerForm({
  initialForm,
  isProject,
  isGlobalOverrideTarget,
  onSubmit,
  onCancel,
}: McpServerFormProps) {
  const idPrefix = useId();
  const [form, dispatch] = useReducer(serverFormReducer, initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    dispatch({ type: "reset", initial: initialForm });
    setError(undefined);
  }, [initialForm]);

  const patchForm = (patch: Partial<ServerFormState>) => {
    dispatch({ type: "patch", patch });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await onSubmit(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ev-settings-card">
      <div className="ev-settings-head">
        <Heading level={4} size={6}>
          {form.mode === "create"
            ? isProject
              ? "添加项目 MCP 服务"
              : "添加 MCP 服务"
            : `编辑 MCP 服务 · ${form.name}`}
        </Heading>
        <IconButton aria-label="关闭编辑表单" onClick={onCancel}>
          <CloseIcon width={16} height={16} />
        </IconButton>
      </div>

      {isProject && form.mode === "edit" && isGlobalOverrideTarget && (
        <div className="ev-inline-hint">
          正在编辑全局服务「{form.name}
          」的项目配置：仅调整启用状态、暴露方式或角色时将保存为轻量项目覆盖；若修改命令或 URL
          等连接参数，将创建项目完整配置。
        </div>
      )}

      {error && <div className="ev-error-banner">{error}</div>}

      <form onSubmit={(event) => void handleSubmit(event)} className="ev-form-stack">
        <div className="ev-mcp-form-top">
          <Field.Root style={{ flex: 1, minWidth: 160 }}>
            <Field.Label>服务名</Field.Label>
            <Input
              type="text"
              value={form.name}
              disabled={form.mode === "edit" || saving}
              onValueChange={(name) => patchForm({ name })}
              placeholder="例如：github"
            />
          </Field.Root>

          <Field.Root>
            <Field.Label>传输方式</Field.Label>
            <SegmentedControl.Root
              density="compact"
              disabled={saving}
              value={[form.transport]}
              onValueChange={(vals) => {
                const next = vals[0];
                if (next === "stdio" || next === "http") {
                  patchForm({ transport: next });
                }
              }}
            >
              <SegmentedControl.Item value="stdio">stdio</SegmentedControl.Item>
              <SegmentedControl.Item value="http">HTTP</SegmentedControl.Item>
            </SegmentedControl.Root>
          </Field.Root>

          <Field.Root style={{ minWidth: 210 }}>
            <Field.Label>默认暴露方式</Field.Label>
            <select
              className="ev-select"
              disabled={saving}
              value={form.exposure}
              onChange={(event) => patchForm({ exposure: normalizeExposure(event.target.value) })}
            >
              {EXPOSURE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field.Root>
        </div>

        <div className="ev-mcp-form-toggles">
          <div className="ev-toggle-field" style={{ flex: "1 1 180px" }}>
            <label htmlFor={`${idPrefix}-form-enabled`}>启用服务</label>
            <Switch.Root
              id={`${idPrefix}-form-enabled`}
              checked={form.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => patchForm({ enabled })}
            >
              <Switch.Thumb />
            </Switch.Root>
          </div>

          <div className="ev-toggle-field" style={{ flex: "2 1 260px" }}>
            <span>可用角色</span>
            <div className="ev-mcp-roles-group">
              <div className="ev-mcp-role-check">
                <Checkbox.Root
                  id={`${idPrefix}-form-role-router`}
                  checked={form.roleRouter}
                  disabled={saving}
                  onCheckedChange={(checked) => patchForm({ roleRouter: checked === true })}
                >
                  <Checkbox.Indicator />
                </Checkbox.Root>
                <label htmlFor={`${idPrefix}-form-role-router`}>Router</label>
              </div>
              <div className="ev-mcp-role-check">
                <Checkbox.Root
                  id={`${idPrefix}-form-role-worker`}
                  checked={form.roleWorker}
                  disabled={saving}
                  onCheckedChange={(checked) => patchForm({ roleWorker: checked === true })}
                >
                  <Checkbox.Indicator />
                </Checkbox.Root>
                <label htmlFor={`${idPrefix}-form-role-worker`}>Worker</label>
              </div>
            </div>
          </div>
        </div>

        <div className="ev-settings-grid-2">
          <Field.Root>
            <Field.Label>描述（可选）</Field.Label>
            <Input
              type="text"
              value={form.description}
              disabled={saving}
              onValueChange={(description) => patchForm({ description })}
              placeholder="一句话说明该服务提供的能力"
            />
          </Field.Root>

          <Field.Root>
            <Field.Label>单次请求超时（秒，可选）</Field.Label>
            <Input
              type="text"
              inputMode="numeric"
              value={form.timeoutText}
              disabled={saving}
              onValueChange={(timeoutText) => patchForm({ timeoutText })}
              placeholder="默认"
            />
          </Field.Root>
        </div>

        {form.transport === "stdio" ? (
          <>
            <div className="ev-settings-grid-2">
              <Field.Root>
                <Field.Label>可执行命令（command）</Field.Label>
                <Input
                  type="text"
                  value={form.command}
                  disabled={saving}
                  onValueChange={(command) => patchForm({ command })}
                  placeholder="npx"
                />
              </Field.Root>
              <Field.Root>
                <Field.Label>工作目录 cwd（可选）</Field.Label>
                <Input
                  type="text"
                  value={form.cwd}
                  disabled={saving}
                  onValueChange={(cwd) => patchForm({ cwd })}
                  placeholder="默认继承项目工作目录"
                />
              </Field.Root>
            </div>

            <Field.Root>
              <Field.Label>参数 args（每行一个，可选）</Field.Label>
              <TextArea
                monospace
                rows={3}
                value={form.argsText}
                disabled={saving}
                onValueChange={(argsText) => patchForm({ argsText })}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."}
              />
            </Field.Root>

            <Field.Root>
              <Field.Label>环境变量 env（可选）</Field.Label>
              <HeadersEditor
                rows={form.envRows}
                disabled={saving}
                itemLabel="环境变量"
                emptyText="暂无自定义环境变量。"
                addLabel="添加环境变量"
                keyPlaceholder="ENV_NAME"
                valuePlaceholder="VALUE（支持 $ENV_VAR 或 !cmd）"
                onChange={(envRows) => patchForm({ envRows })}
              />
            </Field.Root>
          </>
        ) : (
          <>
            <Field.Root>
              <Field.Label>Streamable HTTP URL</Field.Label>
              <Input
                type="text"
                value={form.url}
                disabled={saving}
                onValueChange={(url) => patchForm({ url })}
                placeholder="https://mcp.example.com/mcp"
              />
            </Field.Root>

            <Field.Root>
              <Field.Label>自定义请求头 headers（可选）</Field.Label>
              <HeadersEditor
                rows={form.headerRows}
                disabled={saving}
                onChange={(headerRows) => patchForm({ headerRows })}
              />
            </Field.Root>

            <McpOAuthFields form={form} saving={saving} onPatch={patchForm} />
          </>
        )}

        <div className="ev-inline-actions">
          <Button type="submit" hierarchy="primary" density="compact" pending={saving}>
            保存并应用
          </Button>
          <Button type="button" hierarchy="secondary" density="compact" onClick={onCancel}>
            取消
          </Button>
        </div>
      </form>
    </div>
  );
}
