export type DraftStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function draftStorageKey(draftKey: string): string {
  return `eevee.draft.${draftKey}`;
}

export function restoreFailedDraft(submittedText: string, currentText: string): string {
  if (currentText === "") return submittedText;
  return `${submittedText}\n${currentText}`;
}

export function restoreFailedDraftToStorage(
  storage: DraftStorage,
  draftKey: string,
  submittedText: string,
): boolean {
  const key = draftStorageKey(draftKey);
  const existing = storage.getItem(key) ?? "";
  if (existing !== "") return false;
  storage.setItem(key, submittedText);
  return true;
}
