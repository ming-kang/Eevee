import type { Question, QuestionItem } from "../../src/contracts/index.ts";

export type QuestionItemView = QuestionItem & { why?: string };

export function initialDraft(question: Pick<Question, "items">): string[] {
  return question.items.map((item) => item.recommended ?? "");
}

export function initialOtherFlags(
  question: Pick<Question, "items">,
  draft: readonly string[],
): boolean[] {
  return question.items.map((item, i) => {
    if (item.options.length === 0) return true;
    const val = draft[i] ?? "";
    return val !== "" && !item.options.includes(val);
  });
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
