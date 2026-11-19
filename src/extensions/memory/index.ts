import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type DocumentReader,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { TicketBinding, TicketDoc } from "../../contracts/docs.ts";
import {
  type MemoryChangeDetail,
  type MemoryScope,
  type MemorySource,
  ProblemError,
} from "../../contracts/index.ts";
import { RETIRE_DREAM_TIMER } from "./dreaming.ts";
import { MemoryConflict, type MemoryRepo } from "./repo.ts";

export {
  type DreamDraft,
  type DreamingPort,
  DreamLog,
  type DreamPolicy,
  dreamIfDue,
} from "./dreaming.ts";
export { MemoryConflict, MemoryRepo } from "./repo.ts";

export const MEMORY_TOOL = "memory";
/** The Router's memory: both repositories. */
export const MEMORY_EXTENSION = "eevee.memory";
/** Dreaming's memory: the project repository only. */
export const PROJECT_MEMORY_EXTENSION = "eevee.memory-project";

export type MemoryDeps = {
  repos: Record<MemoryScope, MemoryRepo>;
};

export function createMemory(deps: MemoryDeps) {
  const commitRound = hook(GenerationTask, {
    async afterRun(_run, api, context) {
      const source = await roundSource(api, api.conversationId, context);
      const round = String(api.conversationId);
      await Promise.all(Object.values(deps.repos).map((repo) => repo.commitRound(round, source)));
      return undefined;
    },
  });

  return {
    memory: defineExtension({
      name: MEMORY_EXTENSION,
      tools: [createMemoryTool(deps.repos, ["project", "global"])],
      hooks: [commitRound],
      tasks: [RETIRE_DREAM_TIMER],
    }),
    projectMemory: defineExtension({
      name: PROJECT_MEMORY_EXTENSION,
      tools: [createMemoryTool(deps.repos, ["project"])],
      hooks: [commitRound],
    }),
  };
}

/** The change's author: the dreamer behind a dreamer ticket, the Router otherwise. */
async function roundSource(
  reader: Pick<DocumentReader, "snapshot">,
  conversationId: ConversationId,
  context: Context,
): Promise<MemorySource> {
  const ticketId = (await reader.snapshot(TicketBinding, conversationId, context))?.ticketId;
  if (!ticketId) return { kind: "router" };
  const ticket = await reader.snapshot(TicketDoc, ticketId, context);
  return { kind: ticket?.role === "dreamer" ? "dreaming" : "router", ticketId };
}

function sourceLabel(source: MemorySource): string {
  const name =
    source.kind === "dreaming"
      ? "Dreaming"
      : source.kind === "user"
        ? "User"
        : source.kind === "system"
          ? "Eevee"
          : "Router";
  return source.ticketId === undefined ? name : `${name} ${source.ticketId}`;
}

/** Renders one change's edits as readable unified-style text. */
function renderChange(detail: MemoryChangeDetail): string {
  const out: string[] = [];
  for (const file of detail.files) {
    const status =
      file.status === "added" ? "added" : file.status === "deleted" ? "deleted" : "modified";
    out.push(`${file.path} (${status}, +${file.added} -${file.removed})`);
    if (file.binary) {
      out.push("  binary file");
      continue;
    }
    for (const hunk of file.hunks) {
      out.push(`  ${hunk.header}`);
      for (const line of hunk.lines) {
        const mark = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
        out.push(`  ${mark}${line.text}`);
      }
    }
  }
  return out.join("\n");
}

function createMemoryTool(
  repos: Record<MemoryScope, MemoryRepo>,
  scopes: readonly [MemoryScope, ...MemoryScope[]],
) {
  const withGlobal = scopes.includes("global");
  const Parameters = obj({
    action: oneOf(["edit", "create", "history", "show", "undo"], {
      description: "Which action to run: edit, create, history, show or undo",
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
    change: opt(int({ description: "For show and undo: the number of the change, from history" })),
  });

  return defineTool({
    name: MEMORY_TOOL,
    description:
      "Write to the memory store and browse its history." +
      "Use edit to replace matching text, create to add a new file, history to list recent changes, show to view one change's edits, and undo to reverse one change." +
      "Your edits are saved as one change when this run ends." +
      "Record only experience that stays useful across sessions. Do not record task progress.",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
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
            return text(`Modified ${args.file}; saved as one change when this run ends.`);
          case "create":
            if (!args.file || args.content === undefined)
              return text("The create action needs file and content.", true);
            await repo.create(args.file, args.content, round);
            return text(`Created ${args.file}; saved as one change when this run ends.`);
          case "history": {
            const changes = await repo.history();
            if (changes.length === 0) return text("No history yet.");
            return text(
              changes
                .map((c) => `#${c.id} ${c.at.slice(0, 10)} ${sourceLabel(c.source)} — ${c.summary}`)
                .join("\n"),
            );
          }
          case "show": {
            if (args.change === undefined) return text("The show action needs change.", true);
            const detail = await repo.show(args.change);
            const body = renderChange(detail);
            return text(
              `#${detail.id} ${detail.at.slice(0, 10)} ${sourceLabel(detail.source)} — ${detail.summary}\n${body || "(no text changes)"}`,
            );
          }
          case "undo": {
            if (args.change === undefined) return text("The undo action needs change.", true);
            const source = await roundSource(api, api.conversationId, context);
            const undone = await repo.undo(args.change, source);
            return text(`Undone as change #${undone.id}.`);
          }
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
