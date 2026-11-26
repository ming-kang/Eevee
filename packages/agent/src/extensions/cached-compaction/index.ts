import { contentText, getCurrentSystemMessage, type Usage } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type CompactionReason,
  CompactionTask,
  type ConversationId,
  type ConversationStreamOptions,
  type Cursor,
  DEFAULT_COMPACTION_POLICY,
  defineExtension,
  type EntryId,
  type EntryRecord,
  type Extension,
  hook,
  type ModelRef,
  ProviderDoc,
} from "@earendil-works/pi-durable";
import {
  checkpointSummary,
  extractFileOps,
  keptStart,
  reconstructConversationMessages,
  summaryInstruction,
} from "./summary.ts";

export const CACHED_COMPACTION_EXTENSION = "eevee.cached-compaction";

export type CachedCompactionEvent = {
  readonly conversationId: ConversationId;
  readonly reason: CompactionReason;
  readonly firstKept: EntryId;
  readonly model: ModelRef;
  readonly usage: Usage;
  readonly durationMs: number;
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
};

export type CachedCompactionOptions = {
  readonly maxTokens?: number;
  readonly streamOptions?: ConversationStreamOptions;
  readonly onCompact?: (event: CachedCompactionEvent) => void;
};

const SCAN_PAGE_SIZE = 256;

export function createCachedCompactionExtension(options?: CachedCompactionOptions): Extension {
  return defineExtension({
    name: CACHED_COMPACTION_EXTENSION,
    hooks: [
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, context) => {
          if (compaction.reason === "overflow") return undefined;
          const startedAt = api.now();
          try {
            const agentState = await api.snapshot(AgentDoc, api.conversationId, context);
            const providerState = await api.snapshot(ProviderDoc, api.conversationId, context);
            const ref = agentState?.model;
            if (ref === undefined) return undefined;
            const model = api.models.getModel(ref.provider, ref.modelId);
            if (model === undefined) return undefined;
            const thinkingLevel = agentState?.thinkingLevel ?? "off";
            const sessionId = providerState?.sessionId;

            const keptEntries: EntryRecord[] = [];
            let cursor: Cursor | undefined;
            do {
              const page = await api.entries(
                { minEntryId: compaction.firstKept, order: "ascending" },
                SCAN_PAGE_SIZE,
                cursor,
                context,
              );
              keptEntries.push(...page.items);
              cursor = page.next;
            } while (cursor !== undefined);

            const { messages, keptMessages } = reconstructConversationMessages(
              compaction.entries,
              keptEntries,
            );
            // Without a replayed system message there is no generation prefix whose cache a request
            // over the same leading messages could hit.
            if (getCurrentSystemMessage(messages) === undefined) return undefined;
            const kept = keptStart(messages, keptMessages);
            if (kept === undefined) return undefined;

            const modelKey = `${ref.provider}/${ref.modelId}`;
            const reserve =
              agentState?.compaction?.modelOverrides?.[modelKey]?.reserveTokens ??
              agentState?.compaction?.reserveTokens ??
              DEFAULT_COMPACTION_POLICY.reserveTokens;
            const fallbackMax = Math.floor(0.8 * reserve);
            const requestedMax = options?.maxTokens ?? fallbackMax;
            const maxTokens =
              model.maxTokens > 0 ? Math.min(requestedMax, model.maxTokens) : requestedMax;

            const { deferred: _deferred, ...forwarded } = options?.streamOptions ?? {};
            const response = await api.models.completeSimple(
              model,
              {
                messages: [
                  ...messages,
                  {
                    role: "user",
                    content: [
                      { type: "text", text: summaryInstruction(kept, compaction.instructions) },
                    ],
                    timestamp: api.now(),
                  },
                ],
              },
              {
                ...forwarded,
                maxTokens,
                signal: context.abortSignal,
                telemetry: context.telemetry,
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
              },
            );
            if (context.abortSignal?.aborted === true || response.stopReason === "aborted") {
              return undefined;
            }
            if (
              response.stopReason !== "stop" ||
              response.content.some((block) => block.type === "toolCall")
            ) {
              return undefined;
            }
            const text = contentText(response.content).trim();
            if (text.length === 0) return undefined;

            const fileOps = extractFileOps(compaction.entries);
            const checkpoint = checkpointSummary(text, fileOps);
            try {
              options?.onCompact?.({
                conversationId: api.conversationId,
                reason: compaction.reason,
                firstKept: compaction.firstKept,
                model: { provider: ref.provider, modelId: ref.modelId },
                usage: response.usage,
                durationMs: Math.max(0, api.now() - startedAt),
                readFiles: checkpoint.readFiles,
                modifiedFiles: checkpoint.modifiedFiles,
              });
            } catch {
              // A throwing listener must not turn a valid summary into a native re-summarization.
            }
            return { summary: checkpoint.summary };
          } catch {
            return undefined;
          }
        },
      }),
    ],
  });
}

export {
  type CompactionFileLists,
  checkpointSummary,
  computeFileLists,
  extractFileOps,
  type FileOperations,
  formatFileOperations,
  type KeptStart,
  keptStart,
  type ReconstructedContext,
  reconstructConversationMessages,
  summaryInstruction,
} from "./summary.ts";
