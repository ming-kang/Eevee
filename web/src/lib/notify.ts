import type { BoardView, ProjectSummary } from "../../../src/protocol/contract.ts";
import { effectiveStage } from "./board.ts";
import { t } from "./i18n.ts";
import { failureText } from "./labels.ts";
import type { Route } from "./router.ts";

export type NotifyEvent = {
  /** Stable per occurrence: the browser collapses a re-fired tag instead of stacking cards. */
  tag: string;
  title: string;
  body: string;
  route: Route;
};

/**
 * What changed on one project's board that the user should hear about: a new open question, a
 * ticket whose stage just became `blocked`, a Router failure that newly appeared. The first
 * snapshot (`previous` undefined) only seeds the comparison — emitting for it would re-announce
 * everything already waiting at sign-in.
 */
export function boardEvents(
  previous: BoardView | undefined,
  next: BoardView,
  project: Pick<ProjectSummary, "id" | "title">,
): NotifyEvent[] {
  if (previous === undefined) return [];
  const events: NotifyEvent[] = [];

  const askedBefore = new Set(previous.openQuestions.map((q) => q.id));
  for (const question of next.openQuestions) {
    if (question.answer !== undefined || askedBefore.has(question.id)) continue;
    const text = question.items[0]?.text.replace(/\s+/g, " ").trim();
    events.push({
      tag: `${project.id}:q:${question.id}`,
      title: t("{project} asks you", { project: project.title }),
      body: text !== undefined && text !== "" ? text : question.id,
      route: { name: "chat", pid: project.id },
    });
  }

  const stageBefore = new Map(
    previous.tickets.map((view) => [view.ticket.id, effectiveStage(view)] as const),
  );
  for (const view of next.tickets) {
    if (effectiveStage(view) !== "blocked") continue;
    if (stageBefore.get(view.ticket.id) === "blocked") continue;
    events.push({
      tag: `${project.id}:t:${view.ticket.id}:blocked`,
      title: t("{ticket} is blocked · {project}", {
        ticket: view.ticket.id,
        project: project.title,
      }),
      body: view.ticket.title,
      route: { name: "worker", pid: project.id, tid: view.ticket.id },
    });
  }

  if (previous.router.failure === undefined && next.router.failure !== undefined) {
    events.push({
      tag: `${project.id}:router:failed`,
      title: t("The Router failed · {project}", { project: project.title }),
      body: failureText(next.router.failure),
      route: { name: "chat", pid: project.id },
    });
  }

  return events;
}
