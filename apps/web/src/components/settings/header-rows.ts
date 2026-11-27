import { t } from "../../lib/i18n.ts";

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
  label?: string,
): Record<string, string> | undefined {
  const resolvedLabel = label ?? t("headers.defaultLabel");
  const result: Record<string, string> = {};
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key && !value) continue;
    if (!key) throw new Error(t("headers.missingKey", { label: resolvedLabel, row: index + 1 }));
    if (!value) throw new Error(t("headers.missingValue", { label: resolvedLabel, key }));
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
