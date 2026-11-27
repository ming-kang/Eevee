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
