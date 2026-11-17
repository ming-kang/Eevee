import type { Question } from "@shared/contracts/index.ts";

export function initialDraft(question: Pick<Question, "items">): string[] {
  return question.items.map((item) => item.recommended ?? "");
}

export function isComplete(draft: readonly string[]): boolean {
  return draft.every((answer) => answer.trim() !== "");
}

export function formatAnswer(question: Pick<Question, "items">, draft: readonly string[]): string {
  if (question.items.length === 1) return draft[0]?.trim() ?? "";
  return question.items
    .map((item, i) => `${i + 1}. ${item.text}\n   ${draft[i]?.trim() ?? ""}`)
    .join("\n");
}
