import assert from "node:assert/strict";
import { test } from "node:test";
import { effectScope, nextTick, ref } from "vue";
import type { QuestionId } from "../../../src/domain/index.ts";
import { useQuestionNavigation } from "./question-navigation.ts";

function setup(id: QuestionId | undefined = "q2", loaded = true) {
  const scope = effectScope();
  const target = ref<QuestionId | undefined>(id);
  const questions = ref<readonly { id: QuestionId }[] | undefined>(
    loaded ? [{ id: "q1" }, { id: "q2" }] : undefined,
  );
  const navigated: (QuestionId | undefined)[] = [];
  const panel = scope.run(() =>
    useQuestionNavigation(
      () => target.value,
      () => questions.value,
      (id) => {
        navigated.push(id);
        target.value = id;
      },
    ),
  );
  assert.ok(panel);
  return { scope, target, questions, navigated, panel };
}

test("answering a deep-linked question keeps its history visible before and after the board update", async (t) => {
  const s = setup();
  t.after(() => s.scope.stop());
  assert.equal(s.panel.focusId.value, "q2");
  s.panel.answered("q2");
  assert.equal(s.panel.reviewId.value, "q2");
  s.questions.value = [{ id: "q1" }];
  await nextTick();
  assert.equal(s.target.value, "q2");
  assert.equal(s.panel.reviewId.value, "q2");
  assert.equal(s.panel.focusId.value, undefined);
});

test("a board update arriving before the answer response also preserves the linked question", async (t) => {
  const s = setup();
  t.after(() => s.scope.stop());
  s.questions.value = [{ id: "q1" }];
  await nextTick();
  assert.equal(s.panel.reviewId.value, "q2");
  s.panel.answered("q2");
  assert.equal(s.panel.reviewId.value, "q2");
});

test("closing a missing or answered question clears the route as well as the panel", async (t) => {
  const s = setup("q999999");
  t.after(() => s.scope.stop());
  assert.equal(s.panel.reviewId.value, "q999999");
  s.panel.close();
  await nextTick();
  assert.deepEqual(s.navigated, [undefined]);
  assert.equal(s.target.value, undefined);
  assert.equal(s.panel.reviewId.value, undefined);
  assert.equal(s.panel.focusId.value, undefined);
});

test("a reload waits for the board and reopens the answered target, never the remaining question", async (t) => {
  const s = setup("q2", false);
  t.after(() => s.scope.stop());
  assert.equal(s.panel.reviewId.value, undefined);
  s.questions.value = [{ id: "q1" }];
  await nextTick();
  assert.equal(s.panel.reviewId.value, "q2");
  assert.equal(s.panel.focusId.value, undefined);
});

test("paging updates the route and a late answer cannot replace the new target", async (t) => {
  const s = setup();
  t.after(() => s.scope.stop());
  s.panel.open("q1");
  await nextTick();
  s.panel.answered("q2");
  assert.deepEqual(s.navigated, ["q1"]);
  assert.equal(s.target.value, "q1");
  assert.equal(s.panel.focusId.value, "q1");
  assert.equal(s.panel.reviewId.value, undefined);
});
