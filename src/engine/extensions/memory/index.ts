import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type DocumentReader,
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  runEndTask,
} from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  type AgentMemorySource,
  type MemoryChangeDetail,
  type MemoryOp,
  type MemoryScope,
  type MemorySource,
  ProblemError,
} from "../../../domain/index.ts";
import { MemoryDraft, TicketBinding, TicketDoc } from "../../docs.ts";
import { addProposal } from "../../memory/proposals.ts";
import { MemoryConflict, type MemoryStore } from "../../memory/store.ts";
import { RETIRE_DREAM_TIMER } from "./timer.ts";

export const MEMORY_TOOL = "memory";
/** The Router's memory: both repositories. */
export const MEMORY_EXTENSION = "eevee.memory";
/** Dreaming's memory: the project repository only. */
export const PROJECT_MEMORY_EXTENSION = "eevee.memory-project";

export type MemoryDeps = {
  repos: Record<MemoryScope, MemoryStore>;
};

export function createMemory(deps: MemoryDeps) {
  const submission = (name: string) => {
    const task = defineTask<null, { phase: "submit" }, null>({
      name: `${name}.submit-proposals`,
      version: 1,
      initial: () => ({ phase: "submit" }),
      phases: {
        submit: (_task, runtime, context) =>
          runtime.commit(async (tx) => {
            const draft = await tx.doc(MemoryDraft, runtime.conversationId);
            for (const scope of ["project", "global"] as const) {
              const current = draft.scopes[scope];
              if (!current?.actions.length) continue;
              try {
                if ((await deps.repos[scope].preview(current.actions)).length === 0) continue;
              } catch (error) {
                if (!(error instanceof MemoryConflict || error instanceof ProblemError))
                  throw error;
              }
              await addProposal(tx, {
                scope,
                source: { ...current.source },
                actions: current.actions.map((op) => ({ ...op })),
                conversationId: runtime.conversationId,
                createdAt: current.createdAt,
                summary: current.actions
                  .map(
                    (op) =>
                      `${op.action} ${op.action === "rename" ? `${op.from} -> ${op.to}` : op.file}`,
                  )
                  .join("; "),
              });
            }
            draft.scopes = {};
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context),
      },
      abort: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
    const afterRun = hook(GenerationTask, {
      async afterRun(_run, api, context) {
        const pending = await api.snapshot(MemoryDraft, api.conversationId, context);
        if (!pending || Object.keys(pending.scopes).length === 0) return undefined;
        return { tasks: [runEndTask(task, null)] };
      },
    });
    return { task, afterRun };
  };
  const router = submission(MEMORY_EXTENSION);
  const dreamer = submission(PROJECT_MEMORY_EXTENSION);

  return {
    memory: defineExtension({
      name: MEMORY_EXTENSION,
      tools: [createMemoryTool(deps.repos, ["project", "global"])],
      hooks: [router.afterRun],
      tasks: [router.task, RETIRE_DREAM_TIMER],
    }),
    projectMemory: defineExtension({
      name: PROJECT_MEMORY_EXTENSION,
      tools: [createMemoryTool(deps.repos, ["project", "global"])],
      hooks: [dreamer.afterRun],
      tasks: [dreamer.task],
    }),
  };
}

/** The change's author: the dreamer behind a dreamer ticket, the Router otherwise. */
async function roundSource(
  reader: Pick<DocumentReader, "snapshot">,
  conversationId: ConversationId,
  context: Context,
): Promise<AgentMemorySource> {
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
  repos: Record<MemoryScope, MemoryStore>,
  scopes: readonly [MemoryScope, ...MemoryScope[]],
) {
  const withGlobal = scopes.includes("global");
  const Parameters = obj({
    action: oneOf(["edit", "create", "write", "delete", "rename", "history", "show", "undo"], {
      description:
        "Propose edit, create, write, delete, rename or undo; history and show only read",
    }),
    scope: oneOf(scopes, {
      description: withGlobal
        ? "Use global only when the user explicitly asks to remember something; it can change MEMORY.md only"
        : "Only the project memory store can be tidied up",
    }),
    file: opt(
      str({
        description: "For edit, create and delete: a file name such as MEMORY.md or optics-sim.md",
      }),
    ),
    from: opt(str({ description: "For rename: the existing file name" })),
    to: opt(str({ description: "For rename: the new file name" })),
    oldText: opt(
      str({
        description:
          "For edit: the original text to replace; it must appear exactly once in the file",
      }),
    ),
    newText: opt(str({ description: "For edit: the text that replaces oldText" })),
    content: opt(str({ description: "For create/write: the complete file contents" })),
    change: opt(int({ description: "For show and undo: the number of the change, from history" })),
  });

  return defineTool({
    name: MEMORY_TOOL,
    description:
      "Propose memory changes for the user's approval and browse history." +
      "Use edit to replace matching text, create to add a new file, delete to remove one, rename to move one, history to list recent changes, show to view one change's edits, and undo to reverse one change." +
      "Edits are submitted together for user approval when this run ends. Undo creates a separate proposal immediately. Nothing changes before approval. Rejections or stale proposals come back to the Router as events; re-read memory before proposing again." +
      "Record only experience that stays useful across sessions. Do not record task progress.",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      const repo = repos[args.scope];
      const pending = async (op: MemoryOp) => {
        const source = await roundSource(api, api.conversationId, context);
        await api.commit(async (tx) => {
          const draft = await tx.doc(MemoryDraft, api.conversationId);
          const earlier = draft.scopes[args.scope];
          const actions = await repo.extend(earlier?.actions ?? [], op);
          draft.scopes[args.scope] = {
            actions,
            source,
            createdAt: earlier?.createdAt ?? api.now(),
          };
        }, context);
      };
      try {
        switch (args.action) {
          case "edit":
            if (!args.file || args.oldText === undefined || args.newText === undefined) {
              return text("The edit action needs file, oldText and newText.", true);
            }
            await pending({
              action: "edit",
              file: args.file,
              oldText: args.oldText,
              newText: args.newText,
            });
            return text(
              `Queued edit of ${args.file}; submitted for user approval when this run ends.`,
            );
          case "create":
          case "write":
            if (!args.file || args.content === undefined)
              return text("The create action needs file and content.", true);
            await pending({
              action: args.action,
              file: args.file,
              content: args.content,
            });
            return text(
              `Queued ${args.action} of ${args.file}; submitted for user approval when this run ends.`,
            );
          case "delete":
            if (!args.file) return text("The delete action needs file.", true);
            await pending({ action: "delete", file: args.file });
            return text(
              `Queued deletion of ${args.file}; submitted for user approval when this run ends.`,
            );
          case "rename":
            if (!args.from || !args.to) return text("The rename action needs from and to.", true);
            await pending({ action: "rename", from: args.from, to: args.to });
            return text(
              `Queued rename of ${args.from} to ${args.to}; submitted for user approval when this run ends.`,
            );
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
            const action = await repo.proposeUndo(args.change);
            const proposal = await api.commit(
              (tx) =>
                addProposal(tx, {
                  scope: args.scope,
                  source,
                  conversationId: api.conversationId,
                  createdAt: api.now(),
                  summary: `Undo change #${args.change}`,
                  actions: [action],
                }),
              context,
            );
            return text(
              `Submitted undo proposal ${proposal.id} for user approval. Nothing has been written.`,
            );
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
