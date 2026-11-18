import type { Report, Ticket } from "../contracts/index.ts";
import { REPORT_EXTENSION } from "../extensions/orchestration/index.ts";
import { RESOURCES_EXTENSION } from "../extensions/resources/index.ts";
import { WORKSPACE_EXTENSION } from "../extensions/workspace/index.ts";
import { block, compose, memoryBlocks, renderLatestReport, renderTicket } from "./opening.ts";
import { defineRole } from "./role.ts";

export type WorkerSubject = {
  ticket: Ticket;
  latest?: Report;
  /** The last messages before a reset, so the conversation picks up where it was. */
  recent?: string;
};

const instructions = `You are Eevee's Worker. You complete one ticket. The opening gives you the ticket's contents. Start working right away.

- You coordinate with the Router only through report. The user may also message you directly to steer you. Do as they say, and still hand the result in with report.
- When you make partial progress, hand in a progress report, then keep going.
- When you're done, missing something, unable to go on, or the work turns out to be unnecessary, hand in a closing report (ready, waiting, blocked, failed or dropped). It ends this turn, so make it a call of its own and put it last.
- Put questions that need a user decision into questions, and lessons worth keeping long-term into lessons. Don't bury them in the summary.
- Long commands move to the background on their own. When one finishes, its result wakes you as a new message.
- Read memory on demand with read memory://project/<file>. Look at other tickets' reports with read report://tN.`;

export const workerRole = defineRole<WorkerSubject>({
  name: "worker",
  instructions,
  extensions: [RESOURCES_EXTENSION, WORKSPACE_EXTENSION, REPORT_EXTENSION],
  opening: ({ ticket, latest, recent }, memory) =>
    compose(
      ...memoryBlocks(memory),
      block("ticket", renderTicket(ticket)),
      block("latest-report", renderLatestReport(latest)),
      block("recent", recent),
    ),
});
