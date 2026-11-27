import { Field, Input, Text } from "@earendil-works/elanor-react";
import { type ConnectionNote, providerBaseUrlPlaceholder } from "@eevee/protocol";
import { useI18n } from "../../lib/i18n.ts";
import { describeConnectionUrl, validateBaseUrl } from "./provider-utils.ts";

export type BaseUrlPreviewProps = {
  readonly api?: string;
  readonly baseUrl: string;
  readonly previewBaseUrl?: string;
  readonly fallbackNote?: ConnectionNote;
  readonly previewPrefix?: string;
  readonly warningText?: string;
};

export function BaseUrlPreview({
  api,
  baseUrl,
  previewBaseUrl,
  fallbackNote,
  previewPrefix,
  warningText,
}: BaseUrlPreviewProps) {
  const { t } = useI18n();
  const resolvedPreviewPrefix = previewPrefix ?? t("baseUrl.effectiveUrlPrefix");
  const resolvedWarningText = warningText ?? t("baseUrl.duplicateV1Warning");
  const trimmed = baseUrl.trim();
  const error = trimmed ? validateBaseUrl(trimmed) : undefined;
  const effectiveUrl = previewBaseUrl !== undefined ? previewBaseUrl.trim() : trimmed;
  const note =
    describeConnectionUrl(api, effectiveUrl || undefined) ?? (trimmed ? undefined : fallbackNote);

  return (
    <>
      {error && <Text className="ev-inline-error">{error}</Text>}
      {note && (
        <div className="ev-connection-note" data-warning={note.warning === true}>
          {resolvedPreviewPrefix}
          <span className="ev-mono">{note.text}</span>
          {note.warning && <strong>{resolvedWarningText}</strong>}
        </div>
      )}
    </>
  );
}

export type BaseUrlFieldProps = BaseUrlPreviewProps & {
  readonly label?: string;
  readonly onValueChange: (value: string) => void;
  readonly placeholder?: string;
  readonly hidePreview?: boolean;
  readonly disabled?: boolean;
};

export function BaseUrlField({
  label = "Base URL",
  baseUrl,
  onValueChange,
  api,
  placeholder,
  previewBaseUrl,
  fallbackNote,
  previewPrefix,
  warningText,
  hidePreview = false,
  disabled = false,
}: BaseUrlFieldProps) {
  return (
    <Field.Root>
      <Field.Label>{label}</Field.Label>
      <Input
        type="url"
        value={baseUrl}
        disabled={disabled}
        onValueChange={onValueChange}
        placeholder={placeholder ?? providerBaseUrlPlaceholder(api)}
      />
      {!hidePreview && (
        <BaseUrlPreview
          api={api}
          baseUrl={baseUrl}
          previewBaseUrl={previewBaseUrl}
          fallbackNote={fallbackNote}
          previewPrefix={previewPrefix}
          warningText={warningText}
        />
      )}
    </Field.Root>
  );
}
