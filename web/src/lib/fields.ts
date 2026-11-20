/** One line of a string map being edited: a header, an environment variable. */
export type KeyValueRow = { key: string; value: string };

export function toRows(record: Record<string, string> | undefined): KeyValueRow[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

/** The map the rows make; rows without a key are dropped, and a later key wins. */
export function fromRows(rows: readonly KeyValueRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), row.value] as const)
    .filter(([key]) => key !== "");
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * A token count as typed: `128000`, `128,000`, `128k` or `1.5m`. Undefined for empty text, `NaN` for text
 * that is not a positive whole count.
 */
export function parseTokenCount(text: string): number | undefined {
  const raw = text.trim().toLowerCase().replaceAll(",", "").replaceAll("_", "");
  if (raw === "") return undefined;
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(raw);
  if (!match) return Number.NaN;
  const scale = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
  const value = Math.round(Number(match[1]) * scale);
  return value > 0 ? value : Number.NaN;
}

/** A price or other non-negative number as typed. Undefined for empty text, `NaN` for anything else. */
export function parseAmount(text: string): number | undefined {
  const raw = text.trim();
  if (raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

/** `200k`, `1M`: a token count at a glance. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** A config value that names an environment variable (`$NAME`, `${NAME}`) instead of holding a secret. */
export function isEnvReference(value: string): boolean {
  return /^\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(value.trim());
}
