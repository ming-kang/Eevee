import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { ProblemError, type Question, type QuestionId } from "../../domain/index.ts";
import { QuestionDoc } from "../docs.ts";
import { answerQuestion as recordAnswer } from "../orchestration/index.ts";
import type { Dispatch } from "./dispatch.ts";

type Deps = { harness: Harness; context: Context; dispatch: Dispatch };
export class Questions {
  readonly #deps: Deps;
  constructor(deps: Deps) {
    this.#deps = deps;
  }
  async get(id: QuestionId): Promise<Question> {
    const question = await this.#deps.harness.snapshot(QuestionDoc, id, this.#deps.context);
    if (question === undefined) throw new ProblemError({ code: "no_question", questionId: id });
    return question;
  }

  async answer(id: QuestionId, answer: string, answers?: string[]): Promise<void> {
    const seed = await this.#deps.harness.snapshot(QuestionDoc, id, this.#deps.context);
    if (seed === undefined) throw new ProblemError({ code: "no_question", questionId: id });
    if (answers !== undefined && answers.length !== seed.items.length) {
      throw new ProblemError({ code: "invalid", field: "answers" });
    }
    const now = Date.now();
    const answered = {
      ...seed,
      answer,
      answeredAt: now,
      ...(answers === undefined ? {} : { answers }),
    };
    await this.#deps.dispatch({ type: "question-answered", question: answered }, async (tx) => {
      await recordAnswer(tx, id, answer, now, answers);
    });
  }
}
