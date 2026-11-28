import {
  type MessageChip,
  type MessageSegment,
  type MessageValue,
  normalizeMessageValue,
} from "./composer-value.ts";

export type DraftStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function draftStorageKey(draftKey: string): string {
  return `eevee.draft.v2.${draftKey}`;
}

export function legacyDraftStorageKey(draftKey: string): string {
  return `eevee.draft.${draftKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasStrings(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof record[key] === "string");
}

function isStoredChip(value: unknown): value is MessageChip {
  if (!isRecord(value) || !hasStrings(value, ["id", "label"])) return false;
  switch (value.kind) {
    case "file":
      return hasStrings(value, ["ref", "name", "dir"]);
    case "worker":
      return hasStrings(value, ["ref", "name"]);
    case "ticket":
      return hasStrings(value, ["ref", "title"]);
    case "skill":
      return hasStrings(value, ["name"]);
    default:
      return false;
  }
}

export function parseDraftValue(raw: string): MessageValue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const segments: MessageSegment[] = [];
  for (const segment of parsed) {
    if (typeof segment === "string" || isStoredChip(segment)) segments.push(segment);
  }
  return normalizeMessageValue(segments);
}

export function readDraft(storage: DraftStorage, draftKey: string): MessageValue {
  const stored = storage.getItem(draftStorageKey(draftKey));
  const value = stored === null ? undefined : parseDraftValue(stored);
  if (value) return value;
  const legacy = storage.getItem(legacyDraftStorageKey(draftKey));
  return legacy ? [legacy] : [];
}

export function writeDraft(storage: DraftStorage, draftKey: string, value: MessageValue): void {
  storage.removeItem(legacyDraftStorageKey(draftKey));
  if (value.length === 0) storage.removeItem(draftStorageKey(draftKey));
  else storage.setItem(draftStorageKey(draftKey), JSON.stringify(value));
}

export function restoreFailedDraft(submitted: MessageValue, current: MessageValue): MessageValue {
  if (current.length === 0) return submitted;
  return normalizeMessageValue([...submitted, "\n", ...current]);
}

export function restoreFailedDraftToStorage(
  storage: DraftStorage,
  draftKey: string,
  submitted: MessageValue,
): boolean {
  if (readDraft(storage, draftKey).length > 0) return false;
  writeDraft(storage, draftKey, submitted);
  return true;
}
