import { HelpIcon } from "@earendil-works/elanor-icons-react";
import { Button, Heading, Input, Stack, Text } from "@earendil-works/elanor-react";
import type { QuestionRecordPayload } from "@eevee/protocol";
import { useState } from "react";
import { api } from "../lib/api.ts";

function QuestionCard({
  projectId,
  question,
}: {
  readonly projectId: string;
  readonly question: QuestionRecordPayload;
}) {
  const [answers, setAnswers] = useState<string[]>(() =>
    question.items.map((item) => item.recommended ?? item.options?.[0] ?? ""),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const setAnswer = (index: number, value: string) => {
    setAnswers((prev) => prev.map((entry, idx) => (idx === index ? value : entry)));
  };

  const canSubmit = answers.every((value) => value.trim().length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await api.answerQuestion(projectId, question.id, {
        answers: answers.map((value) => value.trim()),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="eevee-question-card">
      <Stack
        direction="row"
        gap="xSmall"
        align="center"
        style={{ justifyContent: "space-between" }}
      >
        <Stack direction="row" gap="xSmall" align="center">
          <HelpIcon width={18} height={18} />
          <Heading level={3} size={6}>
            Router 等待你的决定（{question.id}）
          </Heading>
        </Stack>
        <span className="eevee-badge" data-tone="warning">
          {question.items.length} 项待回答
        </span>
      </Stack>

      {error && <div className="eevee-error-banner">{error}</div>}

      <Stack direction="column" gap="small">
        {question.items.map((item, idx) => {
          const current = answers[idx] ?? "";
          return (
            <Stack key={`${question.id}:${item.question}`} direction="column" gap="xSmall">
              <Text style={{ margin: 0, fontWeight: 500 }}>
                {idx + 1}. {item.question}
              </Text>
              {item.options && item.options.length > 0 && (
                <div className="eevee-question-options">
                  {item.options.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      className="eevee-option-chip"
                      data-selected={current === opt}
                      onClick={() => setAnswer(idx, opt)}
                    >
                      {opt}
                      {item.recommended === opt ? " (推荐)" : ""}
                    </button>
                  ))}
                </div>
              )}
              <Input
                type="text"
                value={current}
                onValueChange={(value) => setAnswer(idx, value)}
                placeholder="输入回答或补充说明..."
              />
            </Stack>
          );
        })}
      </Stack>

      <Stack direction="row" gap="small" align="center">
        <Button
          hierarchy="primary"
          density="compact"
          disabled={!canSubmit}
          pending={submitting}
          onClick={() => void submit()}
        >
          提交答复
        </Button>
      </Stack>
    </div>
  );
}

export function QuestionBanner({
  projectId,
  questions,
}: {
  readonly projectId: string;
  readonly questions: readonly QuestionRecordPayload[];
}) {
  const pending = questions.filter(
    (q) => q.answeredAt === undefined && q.withdrawnAt === undefined,
  );
  if (pending.length === 0) return null;

  return (
    <div className="eevee-questions-bar">
      {pending.map((question) => (
        <QuestionCard key={question.id} projectId={projectId} question={question} />
      ))}
    </div>
  );
}
