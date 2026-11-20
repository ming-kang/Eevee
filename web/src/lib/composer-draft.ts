/** Page-lifetime drafts survive composer remounts when navigating or setting a question aside. */
const drafts = new Map<string, string>();

export function readDraft(key: string): string {
  return key ? (drafts.get(key) ?? "") : "";
}

export function saveDraft(key: string, text: string): void {
  if (!key) return;
  if (text === "") drafts.delete(key);
  else drafts.set(key, text);
}
