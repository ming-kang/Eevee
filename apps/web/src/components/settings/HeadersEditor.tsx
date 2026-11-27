import { AddIcon, DeleteIcon } from "@earendil-works/elanor-icons-react";
import { Button, IconButton, Input, Text } from "@earendil-works/elanor-react";
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
  itemLabel = "Header",
  emptyText = "暂无自定义请求头。",
  addLabel = "添加 Header",
  keyPlaceholder = "Header-Name",
  valuePlaceholder = "VALUE（支持 $ENV_VAR 或 !cmd）",
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
        <Text className="ev-inline-hint">{emptyText}</Text>
      ) : (
        rows.map((row, index) => (
          <div key={row.uid} className="ev-header-row">
            <Input
              type="text"
              value={row.key}
              disabled={disabled}
              placeholder={keyPlaceholder}
              aria-label={`${itemLabel} ${index + 1} 名称`}
              onValueChange={(key) => updateRow(row.uid, { key })}
            />
            <span className="ev-header-eq" aria-hidden="true">
              =
            </span>
            <Input
              type="text"
              value={row.value}
              disabled={disabled}
              placeholder={valuePlaceholder}
              aria-label={`${itemLabel} ${index + 1} 值`}
              onValueChange={(value) => updateRow(row.uid, { value })}
            />
            <IconButton
              type="button"
              disabled={disabled}
              aria-label={`删除 ${itemLabel} ${row.key || index + 1}`}
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
          {addLabel}
        </Button>
      </div>
    </div>
  );
}
