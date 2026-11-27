import type { AnswerQuestionResponse, BoardViewPayload } from "@eevee/protocol";

export function formatBoard(board: BoardViewPayload): string {
  const lines: string[] = [];
  const activeWorkers = board.workers.filter((worker) => worker.status !== "closed");
  const closedCount = board.workers.length - activeWorkers.length;

  if (activeWorkers.length === 0) {
    lines.push(
      closedCount === 0
        ? "Workers: none yet."
        : `Workers: no active workers (${closedCount} closed).`,
    );
  } else {
    const ticketById = new Map(board.tickets.map((ticket) => [ticket.id, ticket]));
    lines.push("Workers:");
    for (const worker of activeWorkers) {
      const ticket =
        worker.activeTicketId === undefined ? undefined : ticketById.get(worker.activeTicketId);
      const ticketText =
        ticket === undefined ? "no open ticket" : `ticket ${ticket.id} (${ticket.title})`;
      const taskText =
        worker.activeTaskCount === 0
          ? ""
          : `, ${worker.activeTaskCount} running background task(s)`;
      lines.push(`- ${worker.id} "${worker.name}" [${worker.status}] — ${ticketText}${taskText}`);
    }
    if (closedCount > 0) lines.push(`(${closedCount} closed worker(s))`);
  }

  if (board.tickets.length > 0) {
    lines.push("", "Tickets:");
    for (const ticket of board.tickets) {
      const note = ticket.note === undefined ? "" : ` — ${ticket.note}`;
      lines.push(`- ${ticket.id} [${ticket.status}] (${ticket.workerId}) ${ticket.title}${note}`);
    }
  }

  const pendingQuestions = board.questions.filter(
    (question) => question.answeredAt === undefined && question.withdrawnAt === undefined,
  );
  if (pendingQuestions.length > 0) {
    lines.push("", "Unanswered questions:");
    for (const question of pendingQuestions) {
      const summary = question.items.map((item) => item.question).join("; ");
      lines.push(`- ${question.id}: ${summary}`);
    }
  }

  return lines.join("\n");
}

export function formatQuestionAnswered(response: AnswerQuestionResponse): string {
  const { question } = response;
  const count = question.answers?.length ?? 0;
  return `Answered question ${question.id} (${count} answer${count === 1 ? "" : "s"})`;
}
