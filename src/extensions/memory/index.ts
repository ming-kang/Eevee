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
    action: oneOf(["edit", "create", "log", "diff", "revert"]),
    scope: oneOf(scopes, {
      description: withGlobal
        ? "global only allows changing MEMORY.md, and only when the user explicitly asks to remember something"
        : "only the project memory can be tidied up",
    }),
    file: opt(str({ description: "edit / create: e.g. MEMORY.md or optics-sim.md" })),
    oldText: opt(
      str({ description: "edit: the original text to replace; it must match uniquely" }),
    ),
    newText: opt(str({ description: "edit: the replacement text" })),
    content: opt(str({ description: "create: the new file's content" })),
    commit: opt(str({ description: "diff / revert: the target commit" })),
  });

  return defineTool({
    name: MEMORY_TOOL,
    description:
      "Write memory and manage its Git history. edit replaces the matching original text; create is only for new files; log / diff view history; revert undoes one commit." +
      "Changes are committed automatically when the turn ends. Only record experience that stays useful across sessions; don't record task progress.",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api) {
      const repo = repos[args.scope];
      if (args.scope === "global" && args.file !== undefined && args.file !== "MEMORY.md") {
        return text("The global memory has only one file, MEMORY.md.", true);
      }
      const round = String(api.conversationId);
      try {
        switch (args.action) {
          case "edit":
            if (!args.file || args.oldText === undefined || args.newText === undefined) {
              return text("edit needs file, oldText and newText.", true);
            }
            await repo.edit(args.file, args.oldText, args.newText, round);
            return text(`Modified ${args.file}; committed when the turn ends.`);
          case "create":
            if (!args.file || args.content === undefined)
              return text("create needs file and content.", true);
            await repo.create(args.file, args.content, round);
            return text(`Created ${args.file}; committed when the turn ends.`);
          case "log":
            return text((await repo.log()) || "No history yet.");
          case "diff":
            return text((await repo.diff(args.commit)) || "No differences.");
          case "revert":
            if (!args.commit) return text("revert needs commit.", true);
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
