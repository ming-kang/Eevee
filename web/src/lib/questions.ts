import type { Question, QuestionItem } from "../../../src/domain/index.ts";

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

/** The per-item answers, when `answer` is exactly what `formatAnswer` would have produced for these items. */
export function splitFormattedAnswer(
  items: readonly Pick<QuestionItem, "text">[],
  answer: string,
): string[] | undefined {
  if (items.length <= 1) return undefined;
  const parts: string[] = [];
  let rest = answer;
  for (const [i, item] of items.entries()) {
    const head = `${i + 1}. ${item.text}\n   `;
    if (!rest.startsWith(head)) return undefined;
    rest = rest.slice(head.length);
    if (i + 1 === items.length) {
      parts.push(rest);
      break;
    }
    const next = `\n${i + 2}. ${items[i + 1]?.text ?? ""}\n   `;
    const cut = rest.indexOf(next);
    if (cut === -1) return undefined;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1);
  }
  return parts;
}
