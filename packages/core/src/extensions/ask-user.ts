import type { Context } from "@earendil-works/chord/context";
import {
  defineTool,
  type Harness,
  ROOT_CONVERSATION_ID,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { arr, int, lit, obj, opt, str } from "@earendil-works/pi-schema";
import {
  NOTICE_ENTRY_KIND,
  ProjectBoardDoc,
  QuestionDoc,
  type QuestionDocState,
  type QuestionId,
  type QuestionItem,
  type QuestionRecord,
  readQuestion,
} from "../docs.ts";

export function formatQuestionAnswerNotice(
  question: QuestionDocState,
  answers: readonly string[],
): string {
  const lines = [`User answered question ${question.id}:`];
  for (let i = 0; i < question.items.length; i++) {
    const item = question.items[i];
    if (item === undefined) continue;
    lines.push(`${i + 1}. ${item.question}\n   Answer: ${answers[i] ?? ""}`);
  }
  return lines.join("\n");
}

export function createAskUserTool() {
  return defineTool({
    name: "ask_user",
    description:
      "Ask the user one or more structured questions without blocking. Returns immediately so you can keep coordinating work; the user's answers will arrive as a notice once submitted.",
    parameters: obj({
      questions: arr(
        obj({
          question: str({ minLength: 1, description: "Clear question for the user" }),
          options: opt(
            arr(str({ minLength: 1 }), {
              minItems: 1,
              description: "Optional suggested choices",
            }),
          ),
          recommended: opt(str({ minLength: 1, description: "Optional recommended choice" })),
        }),
        { minItems: 1, maxItems: 6, description: "Structured questions for the user" },
      ),
    }),
    structuredOutputSchema: obj({
      questionId: str(),
      count: int({ minimum: 1 }),
      status: lit("pending"),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const items: QuestionItem[] = args.questions.map((item) => ({
        question: item.question,
        ...(item.options === undefined ? {} : { options: [...item.options] }),
        ...(item.recommended === undefined ? {} : { recommended: item.recommended }),
      }));

      const questionId = await api.commit(async (tx) => {
        const board = await tx.doc(ProjectBoardDoc);
        const id = `q${board.nextQuestionSeq}` as QuestionId;
        board.nextQuestionSeq += 1;
        board.questionOrder.push(id);
        const doc = await tx.doc(QuestionDoc, id, null);
        doc.id = id;
        doc.items = items;
        doc.askedAt = api.now();
        return id;
      }, context);

      return {
        output: [
          {
            type: "text",
            text: `Recorded user question ${questionId} (${items.length} item${items.length === 1 ? "" : "s"}). You do not need to wait; the user's answer will arrive automatically when submitted.`,
          },
        ],
        structuredOutput: {
          questionId,
          count: items.length,
          status: "pending",
        },
      };
    },
  });
}

export async function answerQuestion(
  harness: Harness,
  questionId: QuestionId,
  answers: readonly string[],
  context: Context,
): Promise<QuestionRecord> {
  const existing = await readQuestion(harness, questionId, context);
  if (existing === undefined) throw new Error(`Unknown question ${questionId}`);
  if (existing.withdrawnAt !== undefined) {
    throw new Error(`Question ${questionId} was withdrawn`);
  }
  if (existing.answeredAt !== undefined) {
    throw new Error(`Question ${questionId} is already answered`);
  }
  if (answers.length !== existing.items.length) {
    throw new Error(
      `Question ${questionId} expects ${existing.items.length} answer(s), received ${answers.length}`,
    );
  }

  const router = await harness.conversation(ROOT_CONVERSATION_ID, context);
  if (router === undefined) throw new Error("Router conversation is unavailable");

  return harness.commit(async (tx) => {
    const board = await tx.doc(ProjectBoardDoc);
    if (!board.questionOrder.includes(questionId)) {
      throw new Error(`Unknown question ${questionId}`);
    }
    const doc = await tx.doc(QuestionDoc, questionId, null);
    if (doc.withdrawnAt !== undefined) throw new Error(`Question ${questionId} was withdrawn`);
    if (doc.answeredAt !== undefined) throw new Error(`Question ${questionId} is already answered`);
    if (answers.length !== doc.items.length) {
      throw new Error(
        `Question ${questionId} expects ${doc.items.length} answer(s), received ${answers.length}`,
      );
    }

    const answerList = [...answers];
    const items = doc.items.map((item) => ({
      question: item.question,
      ...(item.options === undefined ? {} : { options: [...item.options] }),
      ...(item.recommended === undefined ? {} : { recommended: item.recommended }),
    }));
    const answeredAt = Date.now();
    const content = formatQuestionAnswerNotice(
      {
        id: doc.id,
        items,
        askedAt: doc.askedAt,
      },
      answerList,
    );
    await router.submit(tx, {
      type: "input",
      content,
      whenBusy: "followUp",
      onAbort: "keep",
      requestId: `eevee.answer:${questionId}`,
      entry: {
        kind: NOTICE_ENTRY_KIND,
        data: {
          type: "question_answered",
          questionId,
          answers: answerList,
        },
      },
    });
    doc.answers = answerList;
    doc.answeredAt = answeredAt;
    return {
      id: doc.id,
      items,
      answers: [...answerList],
      askedAt: doc.askedAt,
      answeredAt,
    };
  }, context);
}
