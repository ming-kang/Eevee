import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type DocumentReader,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { TicketBinding, TicketDoc } from "../../contracts/docs.ts";
import { type MemoryScope, ProblemError } from "../../contracts/index.ts";
import { createDreamTimer, type DreamingPort } from "./dreaming.ts";
import { MemoryConflict, type MemoryRepo } from "./repo.ts";

export {
  type DreamDraft,
  type DreamingPort,
  DreamLog,
  type DreamTimer,
  ensureDreamTimer,
} from "./dreaming.ts";
export { type MemoryCommit, MemoryConflict, MemoryRepo } from "./repo.ts";

export const MEMORY_TOOL = "memory";
/** The Router's memory: both repositories, and the Dreaming timer. */
export const MEMORY_EXTENSION = "eevee.memory";
/** Dreaming's memory: the project repository only. */
export const PROJECT_MEMORY_EXTENSION = "eevee.memory-project";

export type MemoryDeps = {
  repos: Record<MemoryScope, MemoryRepo>;
  dreaming: DreamingPort;
};

export function createMemory(deps: MemoryDeps) {
  const commitRound = hook(GenerationTask, {
    async afterRun(_run, api, context) {
      const label = await roundLabel(api, api.conversationId, context);
      const round = String(api.conversationId);
      await Promise.all(Object.values(deps.repos).map((repo) => repo.commitRound(round, label)));
      return undefined;
    },
  });
  const timer = createDreamTimer(deps.dreaming);

  return {
    timer,
    memory: defineExtension({
      name: MEMORY_EXTENSION,
      tools: [createMemoryTool(deps.repos, ["project", "global"])],
      hooks: [commitRound],
      tasks: [timer],
    }),
    projectMemory: defineExtension({
      name: PROJECT_MEMORY_EXTENSION,
      tools: [createMemoryTool(deps.repos, ["project"])],
      hooks: [commitRound],
    }),
  };
}

/** `memory` for the Router's commits, `dreaming tN` for a dreamer ticket's. */
async function roundLabel(
  reader: Pick<DocumentReader, "snapshot">,
  conversationId: ConversationId,
  context: Context,
): Promise<string> {
  const ticketId = (await reader.snapshot(TicketBinding, conversationId, context))?.ticketId;
  if (!ticketId) return "memory";
  const ticket = await reader.snapshot(TicketDoc, ticketId, context);
  return ticket?.role === "dreamer" ? `dreaming ${ticketId}` : `memory ${ticketId}`;
}

function createMemoryTool(
  repos: Record<MemoryScope, MemoryRepo>,
  scopes: readonly [MemoryScope, ...MemoryScope[]],
) {
  const withGlobal = scopes.includes("global");
  const Parameters = obj({
    action: oneOf(["edit", "create", "log", "diff", "revert"], {
      description: "Which action to run: edit, create, log, diff or revert",
    }),
    scope: oneOf(scopes, {
      description: withGlobal
        ? "Use global only when the user explicitly asks to remember something; it can change MEMORY.md only"
        : "Only the project memory store can be tidied up",
    }),
    file: opt(
      str({ description: "For edit and create: a file name such as MEMORY.md or optics-sim.md" }),
    ),
    oldText: opt(
      str({
        description:
          "For edit: the original text to replace; it must appear exactly once in the file",
      }),
    ),
    newText: opt(str({ description: "For edit: the text that replaces oldText" })),
    content: opt(str({ description: "For create: the full content of the new file" })),
    commit: opt(str({ description: "For diff and revert: the target commit" })),
  });

  return defineTool({
    name: MEMORY_TOOL,
    description:
      "Write to the memory store and manage its Git history." +
      "Use edit to replace matching text, create to add a new file, log to view the history, diff to view a commit's changes, and revert to undo one commit." +
      "Changes are committed automatically when the turn ends." +
      "Record only experience that stays useful across sessions. Do not record task progress.",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api) {
      const repo = repos[args.scope];
      if (args.scope === "global" && args.file !== undefined && args.file !== "MEMORY.md") {
        return text("The global memory store has only one file, MEMORY.md.", true);
      }
      const round = String(api.conversationId);
      try {
        switch (args.action) {
          case "edit":
            if (!args.file || args.oldText === undefined || args.newText === undefined) {
              return text("The edit action needs file, oldText and newText.", true);
            }
            await repo.edit(args.file, args.oldText, args.newText, round);
            return text(`Modified ${args.file}. The change is committed when the turn ends.`);
          case "create":
            if (!args.file || args.content === undefined)
              return text("The create action needs file and content.", true);
            await repo.create(args.file, args.content, round);
            return text(`Created ${args.file}. The change is committed when the turn ends.`);
          case "log":
            return text((await repo.log()) || "No history yet.");
          case "diff":
            return text((await repo.diff(args.commit)) || "No differences.");
          case "revert":
            if (!args.commit) return text("The revert action needs commit.", true);
            await repo.revert(args.commit);
            return text(`Reverted ${args.commit}.`);
        }
      } catch (error) {
        if (error instanceof MemoryConflict) {
          return text(`${error.message}\n\nCurrent content:\n${error.current}`, true);
        }
        if (error instanceof ProblemError) return text(error.message, true);
        throw error;
      }
    },
  });
}

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});
