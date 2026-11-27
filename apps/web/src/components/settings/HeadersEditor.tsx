import { AddIcon, DeleteIcon } from "@earendil-works/elanor-icons-react";
import { Button, IconButton, Input, Text } from "@earendil-works/elanor-react";
import { useI18n } from "../../lib/i18n.ts";
import {
  createEmptyHeaderRow,
  type HeaderRow,
  headersToRows,
  rowsToHeaders,
} from "./header-rows.ts";

export { createEmptyHeaderRow, type HeaderRow, headersToRows, rowsToHeaders };

export function HeadersEditor({
  rows,
  onChange,
  disabled = false,
  itemLabel,
  emptyText,
  addLabel,
  keyPlaceholder = "Header-Name",
  valuePlaceholder,
}: {
  readonly rows: readonly HeaderRow[];
  readonly onChange: (rows: HeaderRow[]) => void;
  readonly disabled?: boolean;
  readonly itemLabel?: string;
  readonly emptyText?: string;
  readonly addLabel?: string;
  readonly keyPlaceholder?: string;
  readonly valuePlaceholder?: string;
}) {
  const { t } = useI18n();
  const resolvedItemLabel = itemLabel ?? t("headers.itemLabel");
  const resolvedEmptyText = emptyText ?? t("headers.empty");
  const resolvedAddLabel = addLabel ?? t("headers.add");
  const resolvedValuePlaceholder = valuePlaceholder ?? t("headers.valuePlaceholder");

  const updateRow = (uid: number, patch: Partial<Pick<HeaderRow, "key" | "value">>) => {
    onChange(rows.map((row) => (row.uid === uid ? { ...row, ...patch } : row)));
  };

  const removeRow = (uid: number) => {
    onChange(rows.filter((row) => row.uid !== uid));
  };

  const addRow = () => {
    onChange([...rows, createEmptyHeaderRow()]);
  };

  return (
    <div className="ev-headers-editor">
      {rows.length === 0 ? (
        <Text className="ev-inline-hint">{resolvedEmptyText}</Text>
      ) : (
        rows.map((row, index) => (
          <div key={row.uid} className="ev-header-row">
            <Input
              type="text"
              value={row.key}
              disabled={disabled}
              placeholder={keyPlaceholder}
              aria-label={t("headers.keyAria", { label: resolvedItemLabel, index: index + 1 })}
              onValueChange={(key) => updateRow(row.uid, { key })}
            />
            <span className="ev-header-eq" aria-hidden="true">
              =
            </span>
            <Input
              type="text"
              value={row.value}
              disabled={disabled}
              placeholder={resolvedValuePlaceholder}
              aria-label={t("headers.valueAria", { label: resolvedItemLabel, index: index + 1 })}
              onValueChange={(value) => updateRow(row.uid, { value })}
            />
            <IconButton
              type="button"
              disabled={disabled}
              aria-label={t("headers.deleteAria", {
                label: resolvedItemLabel,
                target: row.key || index + 1,
              })}
              onClick={() => removeRow(row.uid)}
            >
              <DeleteIcon width={15} height={15} />
            </IconButton>
          </div>
        ))
      )}
      <div>
        <Button
          type="button"
          hierarchy="secondary"
          density="compact"
          disabled={disabled}
          iconStart={<AddIcon width={14} height={14} />}
          onClick={addRow}
        >
          {resolvedAddLabel}
        </Button>
      </div>
    </div>
  );
}
