import { AddIcon, DeleteIcon } from "@earendil-works/elanor-icons-react";
import { Button, IconButton, Input, Text } from "@earendil-works/elanor-react";

export type HeaderRow = {
  readonly uid: number;
  readonly key: string;
  readonly value: string;
};

let nextHeaderUid = 1;

export function createEmptyHeaderRow(): HeaderRow {
  return { uid: nextHeaderUid++, key: "", value: "" };
}

export function headersToRows(headers: Readonly<Record<string, string>> | undefined): HeaderRow[] {
  if (!headers) return [];
  return Object.entries(headers).map(([key, value]) => ({
    uid: nextHeaderUid++,
    key,
    value,
  }));
}

export function rowsToHeaders(
  rows: readonly HeaderRow[],
  label = "自定义请求头",
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key && !value) continue;
    if (!key) throw new Error(`${label}第 ${index + 1} 行缺少 Header 名称`);
    if (!value) throw new Error(`${label}「${key}」缺少值`);
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function HeadersEditor({
  rows,
  onChange,
  disabled = false,
}: {
  readonly rows: readonly HeaderRow[];
  readonly onChange: (rows: HeaderRow[]) => void;
  readonly disabled?: boolean;
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
        <Text className="ev-inline-hint">暂无自定义请求头。</Text>
      ) : (
        rows.map((row, index) => (
          <div key={row.uid} className="ev-header-row">
            <Input
              type="text"
              value={row.key}
              disabled={disabled}
              placeholder="Header-Name"
              aria-label={`Header ${index + 1} 名称`}
              onValueChange={(key) => updateRow(row.uid, { key })}
            />
            <span className="ev-header-eq" aria-hidden="true">
              =
            </span>
            <Input
              type="text"
              value={row.value}
              disabled={disabled}
              placeholder="VALUE（支持 $ENV_VAR 或 !cmd）"
              aria-label={`Header ${index + 1} 值`}
              onValueChange={(value) => updateRow(row.uid, { value })}
            />
            <IconButton
              type="button"
              disabled={disabled}
              aria-label={`删除请求头 ${row.key || index + 1}`}
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
          添加 Header
        </Button>
      </div>
    </div>
  );
}
