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
import type { MemoryScope } from "../../contracts/index.ts";
import { createDreamTimer, type DreamingPort } from "./dreaming.ts";
import { MemoryConflict, MemoryHistoryError, type MemoryRepo } from "./repo.ts";

export {
  type DreamDraft,
  type DreamingPort,
  DreamLog,
  type DreamTimer,
  ensureDreamTimer,
} from "./dreaming.ts";
export { type MemoryCommit, MemoryConflict, MemoryHistoryError, MemoryRepo } from "./repo.ts";

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
        ? "global 只允许改 MEMORY.md，且只在用户明确要求记住时使用"
        : "只能整理项目记忆",
    }),
    file: opt(str({ description: "edit / create：如 MEMORY.md 或 optics-sim.md" })),
    oldText: opt(str({ description: "edit：要替换的原文，必须唯一匹配" })),
    newText: opt(str({ description: "edit：替换成的内容" })),
    content: opt(str({ description: "create：新文件内容" })),
    commit: opt(str({ description: "diff / revert：目标 commit" })),
  });

  return defineTool({
    name: MEMORY_TOOL,
    description:
      "写记忆并管理它的 Git 历史。edit 用原文替换；create 只用于新建文件；log / diff 查看历史；revert 撤销一次提交。" +
      "改动在本轮结束时自动提交。只记跨会话长期有用的经验，不记任务进度。",
    parameters: Parameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api) {
      const repo = repos[args.scope];
      if (args.scope === "global" && args.file !== undefined && args.file !== "MEMORY.md") {
        return text("全局记忆只有 MEMORY.md 一个文件。", true);
      }
      const round = String(api.conversationId);
      try {
        switch (args.action) {
          case "edit":
            if (!args.file || args.oldText === undefined || args.newText === undefined) {
              return text("edit 需要 file、oldText 和 newText。", true);
            }
            await repo.edit(args.file, args.oldText, args.newText, round);
            return text(`已修改 ${args.file}，本轮结束时提交。`);
          case "create":
            if (!args.file || args.content === undefined)
              return text("create 需要 file 和 content。", true);
            await repo.create(args.file, args.content, round);
            return text(`已新建 ${args.file}，本轮结束时提交。`);
          case "log":
            return text((await repo.log()) || "还没有历史。");
          case "diff":
            return text((await repo.diff(args.commit)) || "没有差异。");
          case "revert":
            if (!args.commit) return text("revert 需要 commit。", true);
            await repo.revert(args.commit);
            return text(`已撤销 ${args.commit}。`);
        }
      } catch (error) {
        if (error instanceof MemoryConflict) {
          return text(`${error.message}\n\n当前内容：\n${error.current}`, true);
        }
        if (error instanceof MemoryHistoryError) return text(error.message, true);
        throw error;
      }
    },
  });
}

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});
