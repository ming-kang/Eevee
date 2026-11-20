import { ref, watch } from "vue";
import type { Question, QuestionId } from "../../../src/contracts/index.ts";

/** Keep the question panel aligned with its route, including asynchronous answer/board updates. */
export function useQuestionNavigation(
  questionId: () => QuestionId | undefined,
  questions: () => readonly Pick<Question, "id">[] | undefined,
  navigate: (id: QuestionId | undefined) => void,
) {
  const reviewId = ref<QuestionId>();
  const focusId = ref<QuestionId>();

  function show(id: QuestionId): void {
    const pending = questions()?.some((q) => q.id === id);
    reviewId.value = pending ? undefined : id;
    focusId.value = pending ? id : undefined;
  }

  // Watch membership too: answering (even in another tab) must not silently select a different card.
  watch(
    [
      questionId,
      () => questions() !== undefined,
      () => questions()?.some((q) => q.id === questionId()),
    ],
    ([id, loaded]) => {
      reviewId.value = undefined;
      focusId.value = undefined;
      if (loaded && id !== undefined) show(id);
    },
    { immediate: true },
  );

  function open(id: QuestionId): void {
    show(id);
    navigate(id);
  }

  function close(): void {
    reviewId.value = undefined;
    focusId.value = undefined;
    if (questionId() !== undefined) navigate(undefined);
  }

  function answered(id: QuestionId): void {
    if (questionId() !== id) return;
    // The response may beat the board stream. Show history immediately without changing the URL.
    focusId.value = undefined;
    reviewId.value = id;
  }

  return { reviewId, focusId, open, close, answered };
}
