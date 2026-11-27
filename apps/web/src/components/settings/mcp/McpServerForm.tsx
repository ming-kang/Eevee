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
import { useI18n } from "../../../lib/i18n.ts";
import { HeadersEditor } from "../HeadersEditor.tsx";
import {
  EXPOSURE_OPTIONS,
  exposureLabelKey,
  normalizeExposure,
  type ServerFormState,
} from "./codec.ts";
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
  const { t } = useI18n();
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
            ? t(isProject ? "mcp.form.titleCreateProject" : "mcp.form.titleCreate")
            : t("mcp.form.titleEdit", { name: form.name })}
        </Heading>
        <IconButton aria-label={t("mcp.form.closeLabel")} onClick={onCancel}>
          <CloseIcon width={16} height={16} />
        </IconButton>
      </div>

      {isProject && form.mode === "edit" && isGlobalOverrideTarget && (
        <div className="ev-inline-hint">{t("mcp.form.overrideHint", { name: form.name })}</div>
      )}

      {error && <div className="ev-error-banner">{error}</div>}

      <form onSubmit={(event) => void handleSubmit(event)} className="ev-form-stack">
        <div className="ev-mcp-form-top">
          <Field.Root style={{ flex: 1, minWidth: 160 }}>
            <Field.Label>{t("mcp.form.name")}</Field.Label>
            <Input
              type="text"
              value={form.name}
              disabled={form.mode === "edit" || saving}
              onValueChange={(name) => patchForm({ name })}
              placeholder={t("mcp.form.namePlaceholder")}
            />
          </Field.Root>

          <Field.Root>
            <Field.Label>{t("mcp.form.transport")}</Field.Label>
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
            <Field.Label>{t("mcp.form.exposure")}</Field.Label>
            <select
              className="ev-select"
              disabled={saving}
              value={form.exposure}
              onChange={(event) => patchForm({ exposure: normalizeExposure(event.target.value) })}
            >
              {EXPOSURE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(exposureLabelKey(opt.value))}
                </option>
              ))}
            </select>
          </Field.Root>
        </div>

        <div className="ev-mcp-form-toggles">
          <div className="ev-toggle-field" style={{ flex: "1 1 180px" }}>
            <label htmlFor={`${idPrefix}-form-enabled`}>{t("mcp.form.enabled")}</label>
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
            <span>{t("mcp.form.roles")}</span>
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
            <Field.Label>{t("mcp.form.description")}</Field.Label>
            <Input
              type="text"
              value={form.description}
              disabled={saving}
              onValueChange={(description) => patchForm({ description })}
              placeholder={t("mcp.form.descriptionPlaceholder")}
            />
          </Field.Root>

          <Field.Root>
            <Field.Label>{t("mcp.form.timeout")}</Field.Label>
            <Input
              type="text"
              inputMode="numeric"
              value={form.timeoutText}
              disabled={saving}
              onValueChange={(timeoutText) => patchForm({ timeoutText })}
              placeholder={t("common.default")}
            />
          </Field.Root>
        </div>

        {form.transport === "stdio" ? (
          <>
            <div className="ev-settings-grid-2">
              <Field.Root>
                <Field.Label>{t("mcp.form.command")}</Field.Label>
                <Input
                  type="text"
                  value={form.command}
                  disabled={saving}
                  onValueChange={(command) => patchForm({ command })}
                  placeholder="npx"
                />
              </Field.Root>
              <Field.Root>
                <Field.Label>{t("mcp.form.cwd")}</Field.Label>
                <Input
                  type="text"
                  value={form.cwd}
                  disabled={saving}
                  onValueChange={(cwd) => patchForm({ cwd })}
                  placeholder={t("mcp.form.cwdPlaceholder")}
                />
              </Field.Root>
            </div>

            <Field.Root>
              <Field.Label>{t("mcp.form.args")}</Field.Label>
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
              <Field.Label>{t("mcp.form.env")}</Field.Label>
              <HeadersEditor
                rows={form.envRows}
                disabled={saving}
                itemLabel={t("mcp.form.envItemLabel")}
                emptyText={t("mcp.form.envEmpty")}
                addLabel={t("mcp.form.envAdd")}
                keyPlaceholder="ENV_NAME"
                valuePlaceholder={t("mcp.form.valuePlaceholder")}
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
              <Field.Label>{t("mcp.form.headers")}</Field.Label>
              <HeadersEditor
                rows={form.headerRows}
                disabled={saving}
                itemLabel="Header"
                emptyText={t("mcp.form.headersEmpty")}
                addLabel={t("mcp.form.headersAdd")}
                valuePlaceholder={t("mcp.form.valuePlaceholder")}
                onChange={(headerRows) => patchForm({ headerRows })}
              />
            </Field.Root>

            <McpOAuthFields form={form} saving={saving} onPatch={patchForm} />
          </>
        )}

        <div className="ev-inline-actions">
          <Button type="submit" hierarchy="primary" density="compact" pending={saving}>
            {t("mcp.form.saveAndApply")}
          </Button>
          <Button type="button" hierarchy="secondary" density="compact" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    </div>
  );
}
